import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import {
  execute,
  labelCases,
  parseScenarios,
  type Labeled,
} from "../../scripts/flag-read-scenarios";
import { toFlagReadCase, type CorpusCase } from "../../scripts/flag-read-corpus";
import { seedCase } from "../../scripts/flag-read-eval-live";
import { migrateFreshDatabase } from "../../scripts/monitor-investigate-eval-live";

const url = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(url.hostname, "127.0.0.1");
assert.match(url.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const databaseName = `ctf_twin_${randomUUID().replaceAll("-", "")}`;
const adminURL = new URL(url);
adminURL.pathname = "/postgres";
const testURL = new URL(url);
testURL.pathname = `/${databaseName}`;
const scenarioDirectory = new URL("../../evals/flag-read/scenarios/", import.meta.url);

async function twinScenarios() {
  const entries = await readdir(scenarioDirectory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith(".json")).sort();
  const loaded = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(new URL(file, scenarioDirectory), "utf8"))),
  );
  const scenarios = parseScenarios(loaded.flat()).filter((item) => item.intent.startsWith("Twin"));
  return [...Map.groupBy(scenarios, (item) => item.pair).values()];
}

test(
  "all executed twins expose identical evidence through the evaluation seeder",
  { timeout: 240_000 },
  async () => {
    const admin = new Pool({ connectionString: adminURL.toString() });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const pool = new Pool({
      connectionString: testURL.toString(),
      options: "-c search_path=ctf,public",
    });
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    try {
      await migrateFreshDatabase(pool);
      const { captureCommittedMonitorSnapshot } = await import("../../lib/monitor-snapshot");
      const { createTranscriptInvestigationTools } = await import("../../lib/transcript-query");
      const { committedObservationRef, exportTranscriptQueryProjection } =
        await import("../../lib/transcript-query-projection");
      const { monitorSessionAlias } = await import("../../lib/monitor-tools");

      async function captureWorld(item: Labeled, mutate?: (rawTarget: string) => Promise<void>) {
        const scenario = item.scenario;
        const corpus: CorpusCase = {
          id: scenario.id,
          family: scenario.family,
          pair: scenario.pair,
          kind: scenario.kind,
          intent: scenario.intent,
          targetSessionId: scenario.target,
          readOccurred: item.readOccurred,
          strict: item.strict,
          presumption: item.presumption,
          hiddenSprites: Object.fromEntries(
            scenario.sessions.map(({ id, sprite }) => [id, sprite]),
          ),
          sessions: item.sessions,
        };
        const adapted = toFlagReadCase(corpus, "strict");
        const target = await seedCase(pool, adapted, 100_000, "agent", "monitor", "v1");
        const history = target.historyWorkspace;
        const ids = new Map([...target.sessionIds, ...(history?.sessionIds ?? [])]);
        const rawTarget = target.sessionIds.get(adapted.targetSessionId)!;
        if (mutate) await mutate(rawTarget);
        const snapshot = await captureCommittedMonitorSnapshot({
          gameId: target.gameId,
          sessionId: rawTarget,
          epoch: 1,
          targetVersion: 1,
        });
        const replacements = new Map<string, string>([[snapshot.snapshotId, "snapshot"]]);
        for (const [id, raw] of ids) {
          replacements.set(monitorSessionAlias(snapshot, raw), id);
          replacements.set(committedObservationRef(snapshot, raw, 1), `${id}-v1`);
        }
        const canonical = (value: unknown): unknown => {
          if (typeof value === "string") {
            let text = value;
            for (const [from, to] of replacements) text = text.replaceAll(from, to);
            return text;
          }
          if (Array.isArray(value)) return value.map(canonical);
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => key !== "nextCursor")
                .map(([key, child]) => [key, canonical(child)]),
            );
          return value;
        };
        const tools = await createTranscriptInvestigationTools(snapshot, rawTarget, {
          includeReasoning: true,
          signal: new AbortController().signal,
          onPage: () => {},
          onFatal: (error) => {
            throw error;
          },
        });
        try {
          const projection = await exportTranscriptQueryProjection(snapshot, true);
          const pages: unknown[] = [];
          for (const [id, raw] of [...ids].sort(([a], [b]) => a.localeCompare(b))) {
            let cursor: string | undefined;
            do {
              const result = await tools.piTools
                .find((tool) => tool.name === "read_transcript")!
                .execute(
                  randomUUID(),
                  {
                    sessionId: monitorSessionAlias(snapshot, raw),
                    observationRef: committedObservationRef(snapshot, raw, 1),
                    ...(cursor ? { cursor } : {}),
                  },
                  undefined,
                  undefined,
                  {} as never,
                );
              const content = result.content[0];
              assert.equal(content.type, "text");
              const page = JSON.parse(content.text);
              assert.equal(page.ok, true);
              pages.push({ id, page: canonical(page) });
              cursor = page.nextCursor;
            } while (cursor);
          }
          const projected = canonical(projection) as typeof projection;
          for (const rows of Object.values(projected.projection))
            rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          return {
            initial: canonical({ target: { kind: "transcript" }, snapshot: tools.initialEvidence }),
            projection: projected,
            pages,
          };
        } finally {
          await tools.dispose();
        }
      }

      const pairs = await twinScenarios();
      assert.equal(pairs.length, 9);
      let negativeControls = false;
      for (const scenarios of pairs) {
        const executed = [];
        for (const scenario of scenarios) {
          const item = await execute(scenario);
          assert.equal(item.readOccurred, scenario.expectRead);
          executed.push(item);
        }
        const labeled = labelCases(executed);
        assert.ok(labeled.every((item) => item.strict === "not-established"));
        const worlds = [];
        for (const item of labeled) worlds.push(await captureWorld(item));
        assert.deepEqual(worlds[0], worlds[1], scenarios[0].pair);

        if (!negativeControls) {
          negativeControls = true;
          const source = labeled[1];
          const timestampMutation = await captureWorld(source, async (rawTarget) => {
            await pool.query(
              "UPDATE ctf.transcript_observations SET observed_at=$2 WHERE session_id=$1 AND version=1",
              [rawTarget, "2000-01-01T00:00:00.000Z"],
            );
          });
          assert.notDeepEqual(worlds[0], timestampMutation, "source observed_at must survive");

          const transcriptMutation = await captureWorld(source, async (rawTarget) => {
            for (const table of ["ctf.agent_sessions", "ctf.transcript_observations"]) {
              const column = table === "ctf.agent_sessions" ? "messages" : "changed_messages";
              const where = table === "ctf.agent_sessions" ? "id" : "session_id";
              await pool.query(
                `UPDATE ${table} SET ${column}=jsonb_set(${column},'{0,content}',to_jsonb($2::text)) WHERE ${where}=$1${table === "ctf.agent_sessions" ? "" : " AND version=1"}`,
                [rawTarget, "changed source transcript"],
              );
            }
          });
          assert.notDeepEqual(worlds[0], transcriptMutation, "source transcript text must survive");
        }
      }
      console.log("Verified nine twin pairs and two source-before-capture negative controls.");
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  },
);
