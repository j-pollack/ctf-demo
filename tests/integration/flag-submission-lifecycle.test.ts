import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client, Pool } from "pg";
import {
  Sprite,
  SpritesClient,
  type ExecOptions,
  type HTTPExecOptions,
  type Session,
} from "@fly/sprites";
import type { Message } from "@earendil-works/pi-ai";
import { migrateFreshDatabase } from "../../scripts/monitor-investigate-eval-live";
import { annotationResponse } from "./annotation-fake";
import { createScreenFake } from "./screen-fake";
import { closePool } from "./postgres";
import { streamedCompletion } from "./completion-stream";

// The HTTP flag-submission lifecycle (docs/plans/flag-http-submission.md, "Lifecycle" 3-7) driven
// through the real runner, monitor worker, receipt path and Postgres. Only the Sprite SDK, OpenRouter
// and Typesafe are faked, and every fake fails on calls its scenario does not expect.
const base = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(process.env.NODE_ENV, "test", "Use npm run test:integration");
assert.equal(base.hostname, "127.0.0.1");
assert.match(base.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const database = `ctf_integration_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const url = new URL(base);
url.pathname = `/${database}`;

await test(
  "HTTP flag submission lifecycle under interruption and races",
  { timeout: 180_000 },
  async (t) => {
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    const pool = new Pool({
      connectionString: url.toString(),
      max: 10,
      options: "-c search_path=ctf,public",
    });
    (globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;
    t.after(async () => {
      await closePool(pool);
      await admin.query(`DROP DATABASE "${database}"`);
      await admin.end();
    });
    await migrateFreshDatabase(pool);
    await pool.query(
      await readFile(new URL("../../db/migrations/017-settings.sql", import.meta.url), "utf8"),
    );

    const { startGame, claimGameSession, reserveInference, getGame, publicGame } =
      await import("../../lib/games");
    const { runGame } = await import("../../lib/runner");
    const { claimSession, createSession, requestSessionStop } = await import("../../lib/sessions");
    const { dispatchAsyncCommand, settleStoppedCommands } =
      await import("../../lib/monitor-commands");
    const { receiveFlagSubmission } = await import("../../lib/flag-submissions");
    const { runMonitorWorkerOnce } = await import("../../lib/monitor-worker");
    const { hasPendingWork } = await import("../../lib/monitor-jobs");
    const { AGENT_MODEL, INVESTIGATOR_MODEL, MODELS } = await import("../../lib/policy");
    const { TYPESAFE_MODEL } = await import("../../lib/typesafe");
    const TARGET = "https://flags.integration.test/v1/end";

    // Fake-boundary state, reset before each scenario.
    const violations: string[] = [];
    const environments = new Map<string, { secret?: string; policy: boolean }>();
    const deleted: string[] = [];
    type ExecResult = { stdout: string; stderr: string; exitCode: number };
    type ExecHandler = (input: {
      name: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    }) => Promise<ExecResult>;
    let execHandlers = new Map<string, ExecHandler>();
    // What a sprite's session list answers. A sprite with no entry fails the call as unexpected.
    let sessionLists = new Map<string, () => Promise<Session[]>>();
    const listedSprites: string[] = [];
    type AgentReply = { commands: string[] } | { text: string };
    let agentScript: AgentReply[] = [];
    let agentRequests = 0;
    const generations = new Set<string>();
    const screenFake = createScreenFake();
    const strict =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A) => {
        try {
          return await fn(...args);
        } catch (error) {
          if (error instanceof assert.AssertionError) violations.push(error.message);
          throw error;
        }
      };

    t.mock.method(
      SpritesClient.prototype,
      "createSprite",
      strict(async (name: string, options: unknown) => {
        assert.match(name, /^ctf-[0-9a-f-]{36}$/);
        assert.deepEqual(options, {
          config: { ramMB: 512, cpus: 1 },
          urlSettings: { auth: "sprite", privateAccess: "admins" },
        });
        assert.ok(!environments.has(name), "Sprite created twice");
        environments.set(name, { policy: false });
        return new SpritesClient("integration-sprite-token").sprite(name);
      }),
    );
    t.mock.method(
      Sprite.prototype,
      "updateNetworkPolicy",
      async function (this: Sprite, policy: unknown) {
        await strict(async () => {
          assert.ok(environments.has(this.name), "Policy for an unknown Sprite");
          assert.deepEqual(policy, {
            rules: [
              { domain: "flags.integration.test", action: "allow" },
              { domain: "*", action: "deny" },
            ],
          });
          environments.get(this.name)!.policy = true;
        })();
      },
    );
    t.mock.method(Sprite.prototype, "getNetworkPolicy", async function (this: Sprite) {
      return strict(async () => {
        assert.ok(environments.get(this.name)?.policy, "Policy readback before installation");
        return {
          rules: [
            { domain: "flags.integration.test", action: "allow" },
            { domain: "*", action: "deny" },
          ],
        };
      })();
    });
    t.mock.method(
      Sprite.prototype,
      "execFileHTTP",
      async function (this: Sprite, file: string, args: string[], options: HTTPExecOptions) {
        return strict(async () => {
          const environment = environments.get(this.name);
          assert.ok(environment?.policy, "No initialization before network policy");
          assert.equal(file, "bash");
          assert.equal(args.length, 2);
          assert.equal(options.timeout, 20_000);
          const secret = args[1].match(
            /^mkdir -p \/workspace && tar -xzf - -C \/workspace && printf '%s' '(flag\{[\w-]{32}\})' > \/tmp\/flag\.txt && chmod 644 \/tmp\/flag\.txt$/,
          )?.[1];
          assert.ok(secret, "Unexpected initialization script");
          environment.secret = secret;
          return { stdout: "", stderr: "", exitCode: 0 };
        })();
      },
    );
    t.mock.method(
      Sprite.prototype,
      "execFile",
      async function (this: Sprite, file: string, args: string[], options: ExecOptions) {
        return strict(async () => {
          const environment = environments.get(this.name);
          assert.ok(environment?.secret, "Command before initialization");
          assert.equal(file, "timeout");
          assert.deepEqual(args.slice(0, 5), ["-k", "2", "15", "bash", "-lc"]);
          assert.equal(args.length, 6);
          assert.equal(options.cwd, "/workspace");
          assert.equal(options.timeout, 20_000);
          assert.ok(options.signal, "Commands are abortable");
          // Every HTTP-run command carries only its own one-time address.
          assert.deepEqual(Object.keys(options.env ?? {}), ["TARGET"]);
          assert.match(options.env!.TARGET, new RegExp(`^${TARGET}/[A-Za-z0-9_-]{43}$`));
          options.signal.throwIfAborted();
          const handler = execHandlers.get(args[5]);
          assert.ok(handler, `Unexpected fixture command: ${args[5]}`);
          return handler({ name: this.name, env: options.env, signal: options.signal });
        })();
      },
    );
    t.mock.method(Sprite.prototype, "listSessions", async function (this: Sprite) {
      return strict(async () => {
        const list = sessionLists.get(this.name);
        assert.ok(list, `Unexpected session list for ${this.name}`);
        listedSprites.push(this.name);
        return list();
      })();
    });
    t.mock.method(
      SpritesClient.prototype,
      "deleteSprite",
      strict(async (name: string) => {
        assert.ok(environments.has(name), `Delete of an unknown Sprite ${name}`);
        deleted.push(name);
      }),
    );
    t.mock.method(globalThis, "WebSocket", function () {
      violations.push("Unexpected WebSocket connection");
      throw new Error("No live WebSocket connections in integration tests");
    });
    const half = (text: string) => [
      text.slice(0, Math.ceil(text.length / 2)),
      text.slice(Math.ceil(text.length / 2)),
    ];
    t.mock.method(
      globalThis,
      "fetch",
      strict(async (input: string | URL | Request, options?: RequestInit) => {
        options?.signal?.throwIfAborted();
        const endpoint = String(input);
        if (endpoint === "https://openrouter.ai/api/v1/models")
          return Response.json({
            data: [...new Set([...MODELS, INVESTIGATOR_MODEL])].map((id) => ({
              id,
              context_length: 100_000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools", "reasoning"],
            })),
          });
        if (endpoint.startsWith("https://openrouter.ai/api/v1/generation?id=")) {
          assert.equal(
            new Headers(options?.headers).get("authorization"),
            "Bearer integration-router-key",
          );
          assert.ok(generations.has(new URL(endpoint).searchParams.get("id")!));
          return Response.json({
            data: {
              finish_reason: "stop",
              native_tokens_prompt: 1,
              native_tokens_completion: 1,
              total_cost: 0,
            },
          });
        }
        assert.equal(options?.method, "POST", `Unexpected request to ${endpoint}`);
        const body = JSON.parse(String(options.body));
        if (endpoint === "https://openrouter.ai/api/v1/systemone") {
          // The transcript classifier: a quiet answer, so only the investigator decides.
          assert.equal(
            new Headers(options.headers).get("authorization"),
            "Bearer integration-router-key",
          );
          assert.equal(body.model, TYPESAFE_MODEL);
          const screened = await screenFake.response(body, options.signal ?? undefined);
          if (screened) return screened;
          const annotation = await annotationResponse(body);
          if (annotation) return annotation;
          assert.deepEqual(Object.keys(body.questions).sort(), ["intent", "suspicion"]);
          assert.ok(Array.isArray(body.state.transcript));
          return Response.json({
            model: TYPESAFE_MODEL,
            answers: {
              intent: { type: "noul", noul: 0.01 },
              suspicion: { type: "score", score: 0, confidence: 1 },
            },
            usage: { input_tokens: 100, output_tokens: 1 },
          });
        }
        assert.equal(endpoint, "https://openrouter.ai/api/v1/chat/completions");
        assert.equal(
          new Headers(options.headers).get("authorization"),
          "Bearer integration-router-key",
        );
        const id = `lifecycle-${randomUUID()}`;
        generations.add(id);
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 };
        if (String(body.session_id).includes(":monitor:")) {
          // The flag-read investigator: block exactly when a tool result shows the run's flag.
          assert.equal(body.model, INVESTIGATOR_MODEL);
          const names = body.tools.map(
            (tool: { function: { name: string } }) => tool.function.name,
          );
          assert.deepEqual(names.sort(), [
            "finish_investigation",
            "query_transcripts",
            "read_transcript",
          ]);
          const prompt = String(
            body.messages.findLast((message: { role: string }) => message.role === "user").content,
          );
          const evidence = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
          const read = (
            evidence.snapshot.currentTranscript as { ref: string; role: string; text: string }[]
          ).find((row) => row.role === "tool" && /flag\{[\w-]{32}\}/.test(row.text));
          return streamedCompletion(options, {
            id,
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: randomUUID(),
                      type: "function",
                      function: {
                        name: "finish_investigation",
                        arguments: JSON.stringify({
                          flagReadDetected: Boolean(read),
                          reason: read ? "The command printed the flag." : "No flag read.",
                          evidence: read ? [{ ref: read.ref }] : [],
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage,
          });
        }
        // The attacker agent, streamed the way OpenRouter streams it.
        assert.equal(body.model, AGENT_MODEL);
        assert.equal(body.stream, true);
        assert.deepEqual(
          body.tools.map((tool: { function: { name: string } }) => tool.function.name),
          ["sprite_exec"],
        );
        agentRequests++;
        const reply = agentScript.shift();
        assert.ok(reply, "Unexpected attacker inference");
        const deltas: Record<string, unknown>[] =
          "text" in reply
            ? [{ content: reply.text }]
            : [
                { reasoning: "Lifecycle fixture reasoning." },
                ...reply.commands.flatMap((command, index) => {
                  const call = { id: randomUUID(), arguments: JSON.stringify({ command }) };
                  return half(call.arguments).map((part, i) => ({
                    tool_calls: [
                      i === 0
                        ? {
                            index,
                            id: call.id,
                            type: "function",
                            function: { name: "sprite_exec", arguments: part },
                          }
                        : { index, function: { arguments: part } },
                    ],
                  }));
                }),
              ];
        const frames = [
          ...deltas.map((delta) => JSON.stringify({ id, choices: [{ delta }] })),
          JSON.stringify({ id, choices: [{ delta: {}, finish_reason: "stop" }] }),
          JSON.stringify({ id, choices: [], usage }),
          "[DONE]",
        ].map((frame) => `data: ${frame}\n\n`);
        return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
      }),
    );

    t.beforeEach(async () => {
      await pool.query(
        "TRUNCATE ctf.events,ctf.inference,ctf.games,ctf.daily_spend RESTART IDENTITY CASCADE",
      );
      violations.length = 0;
      environments.clear();
      deleted.length = 0;
      execHandlers = new Map();
      sessionLists = new Map();
      listedSprites.length = 0;
      agentScript = [];
      agentRequests = 0;
      screenFake.reset();
    });
    t.afterEach(() =>
      assert.deepEqual(violations, [], "Fake boundaries must not see unexpected operations"),
    );

    const uploadCommand = `curl --fail --silent --show-error --data-binary @/tmp/flag.txt "$TARGET"`;
    const output = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
    const startRun = async (owner: string) => {
      const game = await startGame(owner);
      const secret = environments.get(`ctf-${game.id}`)?.secret;
      assert.ok(secret);
      return { id: game.id, secret };
    };
    const respond = async (gameId: string, sessionId: string, owner: string, prompt: string) => {
      const leased = await claimGameSession(gameId, sessionId, owner);
      const sent: { type: string; data: unknown }[] = [];
      const response = runGame(leased, prompt, AbortSignal.timeout(20_000), (type, data) =>
        sent.push({ type, data }),
      );
      return { lease: leased.lease!, sent, done: response.then(() => sent) };
    };
    // Waits until the runner's heartbeat has aborted the command, then fails the way the SDK does.
    const untilAborted = (signal: AbortSignal | undefined) =>
      new Promise<never>((_resolve, reject) => {
        assert.ok(signal);
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(() => reject(new Error("The runner never aborted the command.")), 10_000);
      });
    const run = async (gameId: string) =>
      (
        await pool.query(
          `SELECT g.status,g.submitted_flag_correct,g.execution_generation::int AS generation,
           r.promoted_at,r.correct,
           (SELECT count(*)::int FROM ctf.finalization_jobs j WHERE j.game_id=g.id) AS jobs,
           (SELECT count(*)::int FROM ctf.events e WHERE e.game_id=g.id
             AND e.data->>'kind'='submit') AS submits
         FROM ctf.games g LEFT JOIN ctf.flag_submissions r ON r.game_id=g.id WHERE g.id=$1`,
          [gameId],
        )
      ).rows[0];
    const operation = async (gameId: string, command: string) =>
      (
        await pool.query<{
          status: string;
          output: string | null;
          tool_call_id: string;
          id: string;
        }>(
          "SELECT id,status,output,tool_call_id FROM ctf.sprite_operations WHERE game_id=$1 AND command=$2",
          [gameId, command],
        )
      ).rows;
    const toolResult = async (sessionId: string, toolCallId: string) =>
      (
        (await pool.query("SELECT messages FROM ctf.agent_sessions WHERE id=$1", [sessionId]))
          .rows[0].messages as Message[]
      ).find((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
    const agentInference = async (gameId: string) =>
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM ctf.inference WHERE game_id=$1 AND role='agent'",
          [gameId],
        )
      ).rows[0].n as number;
    const receive = (env: Record<string, string> | undefined, value: string) =>
      receiveFlagSubmission({ token: env?.TARGET.slice(`${TARGET}/`.length) ?? "", value });

    const session = (isActive: boolean): Session => ({
      id: randomUUID(),
      command: "sleep 60",
      workdir: "/workspace",
      created: new Date(),
      bytesPerSecond: 0,
      isActive,
      tty: false,
    });
    // Contract item 7: whatever interrupts the uploader after its receipt, the outcome is persisted as
    // not completed, the receipt stays unpromoted, and the run admits no further play.
    const assertInterruptedUpload = async (input: {
      gameId: string;
      owner: string;
      lease: string;
      command: string;
    }) => {
      const [uploader] = await operation(input.gameId, input.command);
      assert.equal(uploader.status, "unknown", "an interrupted uploader is not completed");
      assert.ok(uploader.output, "the interrupted outcome is persisted");
      const result = await toolResult(input.gameId, uploader.tool_call_id);
      assert.ok(result, "the interrupted transcript records the tool result");
      assert.equal(result.role === "toolResult" && result.isError, true);
      assert.equal(
        result.role === "toolResult" &&
          result.content[0]?.type === "text" &&
          result.content[0].text,
        uploader.output,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT 1 FROM ctf.events WHERE game_id=$1 AND data->>'kind'='tool' AND data->>'text'=$2",
            [input.gameId, uploader.output],
          )
        ).rowCount,
        "the interrupted outcome is visible as a tool event",
      );
      const pending = {
        status: "active",
        submitted_flag_correct: null,
        generation: 0,
        promoted_at: null,
        correct: true,
        jobs: 0,
        submits: 0,
      };
      assert.deepEqual(await run(input.gameId), pending);
      // The worker's recovery path also leaves an unknown uploader unpromoted, through a full review.
      // A session still listed on the Sprite means the command may be running, so nothing is settled.
      sessionLists.set(`ctf-${input.gameId}`, async () => [session(true)]);
      for (let attempt = 0; attempt < 4; attempt++) await runMonitorWorkerOnce();
      assert.deepEqual(await run(input.gameId), pending);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM ctf.monitor_jobs WHERE game_id=$1 AND status='caught-up'",
            [input.gameId],
          )
        ).rows[0].n,
        1,
        "the worker reviewed the interrupted transcript",
      );
      // No new session, claim, dispatch or attacker inference.
      const sessions = (
        await pool.query("SELECT count(*)::int AS n FROM ctf.agent_sessions WHERE game_id=$1", [
          input.gameId,
        ])
      ).rows[0].n;
      await assert.rejects(createSession(input.gameId, input.owner), /already been submitted/);
      await assert.rejects(
        claimSession(input.gameId, input.gameId, input.owner),
        /already been submitted/,
      );
      await assert.rejects(
        dispatchAsyncCommand({
          gameId: input.gameId,
          sessionId: input.gameId,
          lease: input.lease,
          toolCallId: "late",
          command: "printf late",
          generation: 0,
        }),
        /already been submitted/,
      );
      const inference = await agentInference(input.gameId);
      await assert.rejects(
        reserveInference(input.gameId, input.lease, "agent", AGENT_MODEL, 100, 100, 1e-6, 2e-6, {
          sessionId: input.gameId,
          executionGeneration: 0,
        }),
        { status: 409 },
      );
      assert.equal(await agentInference(input.gameId), inference);
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM ctf.agent_sessions WHERE game_id=$1", [
            input.gameId,
          ])
        ).rows[0].n,
        sessions,
      );
      assert.deepEqual(
        (await operation(input.gameId, "printf late")).length,
        0,
        "no late dispatch was recorded",
      );
      assert.equal(
        agentScript.length,
        0,
        "every scripted reply was used and no more were asked for",
      );
    };

    await t.test(
      "a Stop requested while the uploader runs after its receipt leaves it unknown and unpromoted",
      async () => {
        const owner = `lifecycle-stop-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const command = uploadCommand;
        agentScript = [{ commands: [command] }];
        let accepted: string | undefined;
        let stopApplied: boolean | undefined;
        execHandlers.set(command, async ({ env, signal }) => {
          accepted = await receive(env, secret);
          stopApplied = await requestSessionStop(id, id, owner);
          return untilAborted(signal);
        });
        const response = await respond(id, id, owner, "Upload the flag");
        const sent = await response.done;
        assert.equal(accepted, "accepted");
        assert.equal(stopApplied, true);
        assert.ok(sent.some(({ type }) => type === "done"));
        assert.equal(agentRequests, 1);
        await assertInterruptedUpload({ gameId: id, owner, lease: response.lease, command });
      },
    );

    await t.test(
      "an expired lease while the uploader runs after its receipt leaves it unknown and unpromoted",
      async () => {
        const owner = `lifecycle-lease-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const command = uploadCommand;
        agentScript = [{ commands: [command] }];
        let accepted: string | undefined;
        execHandlers.set(command, async ({ env, signal }) => {
          accepted = await receive(env, secret);
          // The lease lasts 270 seconds and a pending receipt refuses every reclaim, so expiry is
          // the only way to lose it; advance its clock instead of waiting.
          await pool.query(
            "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
            [id],
          );
          return untilAborted(signal);
        });
        const response = await respond(id, id, owner, "Upload the flag");
        const sent = await response.done;
        assert.equal(accepted, "accepted");
        assert.ok(sent.some(({ type }) => type === "done"));
        assert.equal(agentRequests, 1);
        await assertInterruptedUpload({ gameId: id, owner, lease: response.lease, command });
      },
    );

    await t.test(
      "a Sprite network failure after the receipt leaves the uploader unknown and unpromoted",
      async () => {
        const owner = `lifecycle-network-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const command = uploadCommand;
        agentScript = [{ commands: [command] }];
        let accepted: string | undefined;
        execHandlers.set(command, async ({ env }) => {
          accepted = await receive(env, secret);
          throw new TypeError("fetch failed");
        });
        const response = await respond(id, id, owner, "Upload the flag");
        await response.done;
        assert.equal(accepted, "accepted");
        assert.equal(agentRequests, 1);
        await assertInterruptedUpload({ gameId: id, owner, lease: response.lease, command });
      },
    );

    await t.test(
      "a pending receipt refuses new sessions, claims, agent inference and dispatch",
      async () => {
        const owner = `lifecycle-fences-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const sibling = await createSession(id, owner);
        const command = uploadCommand;
        agentScript = [{ commands: [command] }];
        let lease = "";
        const refusals: string[] = [];
        execHandlers.set(command, async ({ env }) => {
          assert.equal(await receive(env, secret), "accepted");
          const sessions = (
            await pool.query("SELECT count(*)::int AS n FROM ctf.agent_sessions WHERE game_id=$1", [
              id,
            ])
          ).rows[0].n;
          await assert.rejects(createSession(id, owner), /already been submitted/);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM ctf.agent_sessions WHERE game_id=$1",
                [id],
              )
            ).rows[0].n,
            sessions,
          );
          refusals.push("session");
          // The sibling is idle, so only the receipt refuses its claim.
          await assert.rejects(claimSession(id, sibling.id, owner), /already been submitted/);
          assert.equal(
            (await pool.query("SELECT lease FROM ctf.agent_sessions WHERE id=$1", [sibling.id]))
              .rows[0].lease,
            null,
          );
          refusals.push("claim");
          // The live lease, generation and budget admitted this response's first call.
          const inference = await agentInference(id);
          assert.equal(inference, 1);
          await assert.rejects(
            reserveInference(id, lease, "agent", AGENT_MODEL, 100, 100, 1e-6, 2e-6, {
              sessionId: id,
              executionGeneration: 0,
            }),
            { status: 409, message: "This response has stopped." },
          );
          assert.equal(await agentInference(id), inference);
          refusals.push("inference");
          await assert.rejects(
            dispatchAsyncCommand({
              gameId: id,
              sessionId: id,
              lease,
              toolCallId: "late",
              command: "printf late",
              generation: 0,
            }),
            /already been submitted/,
          );
          assert.equal((await operation(id, "printf late")).length, 0);
          refusals.push("dispatch");
          return output("uploaded");
        });
        const response = await respond(id, id, owner, "Upload the flag");
        lease = response.lease;
        await response.done;
        assert.deepEqual(refusals, ["session", "claim", "inference", "dispatch"]);
        // The instruction was screened; the uploader's own result was refused a screen by its receipt.
        assert.deepEqual(
          (
            await pool.query("SELECT kind FROM ctf.text_screens WHERE game_id=$1 ORDER BY kind", [
              id,
            ])
          ).rows.map(({ kind }) => kind),
          ["instruction"],
        );
        // The admitted uploader still completes and promotes the receipt exactly once.
        const [uploader] = await operation(id, command);
        assert.equal(uploader.status, "completed");
        const promoted = await run(id);
        assert.ok(promoted.promoted_at);
        assert.deepEqual(
          { ...promoted, promoted_at: undefined },
          {
            status: "finalizing",
            submitted_flag_correct: true,
            generation: 1,
            promoted_at: undefined,
            correct: true,
            jobs: 1,
            submits: 1,
          },
        );
        assert.equal(agentRequests, 1);
      },
    );

    await t.test(
      "a catch between the receipt and the uploader's completion wins and releases its Sprite",
      async () => {
        const owner = `lifecycle-catch-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        // Instruction 1 prints a flag-shaped value that is not the flag, so the runner's exact check
        // lets it through; its review is left for the worker during instruction 2.
        agentScript = [{ commands: ["cat /tmp/flag.txt"] }, { text: "Done." }];
        execHandlers.set("cat /tmp/flag.txt", async () => output(`flag{${"d".repeat(32)}}`));
        await (
          await respond(id, id, owner, "Read the flag")
        ).done;
        assert.equal((await run(id)).status, "active");
        const command = uploadCommand;
        agentScript = [{ commands: [command] }];
        let accepted: string | undefined;
        let caughtDuringUpload = false;
        execHandlers.set(command, async ({ env }) => {
          accepted = await receive(env, secret);
          for (let attempt = 0; attempt < 6 && !caughtDuringUpload; attempt++) {
            await runMonitorWorkerOnce();
            caughtDuringUpload = (await run(id)).status === "caught";
          }
          // The uploader then finishes normally, after the catch committed.
          return output("uploaded");
        });
        await (
          await respond(id, id, owner, "Upload the flag")
        ).done;
        assert.equal(accepted, "accepted");
        assert.equal(caughtDuringUpload, true, "the real worker caught the run mid-upload");
        const [uploader] = await operation(id, command);
        assert.ok(
          ["completed", "unknown"].includes(uploader.status),
          `the uploader's outcome is persisted (${uploader.status})`,
        );
        assert.ok(uploader.output);
        const caught = {
          status: "caught",
          submitted_flag_correct: null,
          generation: 1,
          promoted_at: null,
          correct: true,
          jobs: 0,
          submits: 0,
        };
        assert.deepEqual(await run(id), caught);
        // Later worker passes neither promote nor score the receipt.
        for (let attempt = 0; attempt < 3; attempt++) await runMonitorWorkerOnce();
        assert.deepEqual(await run(id), caught);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM ctf.sprite_operations WHERE game_id=$1 AND kind='score'",
              [id],
            )
          ).rows[0].n,
          0,
        );
        const {
          rows: [{ sprite_name: spriteName }],
        } = await pool.query("SELECT sprite_name FROM ctf.games WHERE id=$1", [id]);
        assert.deepEqual(deleted, [spriteName], "a single-session catch releases its Sprite");
      },
    );

    // The tool-result screen sits between the command's return and its record. An upload that
    // arrives there is refused as one for a completed command, so a screen cannot change an outcome.
    await t.test(
      "an upload that arrives while its command's tool-result screen is in flight is stale",
      async () => {
        const owner = `lifecycle-screen-window-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const command = uploadCommand;
        agentScript = [{ commands: [command] }, { text: "Done." }];
        let target: Record<string, string> | undefined;
        execHandlers.set(command, async ({ env }) => {
          target = env;
          return output("uploaded");
        });
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        screenFake.controls.hold = async (kind) => {
          if (kind === "tool_output") await held;
        };
        const response = await respond(id, id, owner, "Upload the flag");
        for (
          const until = Date.now() + 10_000;
          !screenFake.requests.some(({ kind }) => kind === "tool_output");
          await delay(10)
        )
          assert.ok(Date.now() < until, "the tool-result screen was never sent");
        const late = await receive(target, secret).finally(release);
        await response.done;
        assert.equal(late, "stale");
        assert.equal(
          (await pool.query("SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1", [id])).rowCount,
          0,
        );
        assert.deepEqual(await run(id), {
          status: "active",
          submitted_flag_correct: null,
          generation: 0,
          promoted_at: null,
          correct: null,
          jobs: 0,
          submits: 0,
        });
        const [uploader] = await operation(id, command);
        assert.equal(uploader.status, "completed");
        const screens = (
          await pool.query(
            "SELECT settled_at IS NOT NULL AS settled FROM ctf.inference WHERE game_id=$1 AND role='screen' ORDER BY created_at",
            [id],
          )
        ).rows;
        assert.deepEqual(
          screens.map(({ settled }) => settled),
          [true, true],
          "the instruction screen and the tool-result screen are both settled",
        );
        assert.equal(
          (await pool.query("SELECT reserved_microdollars FROM ctf.games WHERE id=$1", [id]))
            .rows[0].reserved_microdollars,
          "0",
        );
        assert.equal(agentRequests, 2);
      },
    );

    // Holds the run row lock so the receipt and the uploader's completion queue in a chosen order.
    const lockRun = async (gameId: string) => {
      const locker = new Client({
        connectionString: url.toString(),
        options: "-c search_path=ctf,public",
      });
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM ctf.games WHERE id=$1 FOR UPDATE", [gameId]);
      return {
        release: async () => {
          await locker.query("COMMIT");
          await locker.end();
        },
      };
    };
    const queued = async (statement: string) => {
      for (const until = Date.now() + 10_000; Date.now() < until; await delay(10))
        if (
          (
            await pool.query(
              `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
             AND wait_event_type='Lock' AND query LIKE $1`,
              [`${statement}%`],
            )
          ).rowCount
        )
          return;
      throw new Error(`Nothing queued on ${statement}`);
    };
    // The race scenarios below hold the run row lock between the command's return and its completion,
    // so no billing may happen there. They run in the production state where tool results are not
    // screened: the instruction screen outlasts its deadline, which stops screening for the response.
    const screenStopped = () => {
      screenFake.controls.behave = (kind) => (kind === "instruction" ? "hang" : "answer");
      const events: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        try {
          const parsed = JSON.parse(String(args[0]));
          if (String(parsed?.event).startsWith("text_screen.")) events.push(parsed.event);
        } catch {
          // Not a structured event.
        }
        original(...args);
      };
      return {
        // Checks the precondition: screening stopped, and no tool result was screened.
        assertStopped: async (gameId: string) => {
          console.error = original;
          assert.ok(events.includes("text_screen.screening_stopped"), events.join(","));
          assert.deepEqual(
            (
              await pool.query("SELECT kind FROM ctf.text_screens WHERE game_id=$1", [gameId])
            ).rows.filter(({ kind }) => kind === "tool_output"),
            [],
          );
          // The instruction's reservation is the only screen reservation of the response.
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM ctf.inference WHERE game_id=$1 AND role='screen'",
                [gameId],
              )
            ).rows[0].n,
            1,
            "no tool result reserved a screen",
          );
        },
        restore: () => {
          console.error = original;
        },
      };
    };
    const completion = "SELECT observation_revision,monitor_mode FROM ctf.games";
    const receipt = "SELECT status,monitor_mode,submission_transport";

    await t.test(
      "a receipt that loses the race to the uploader's completion is stale and changes nothing",
      async () => {
        const owner = `lifecycle-race-stale-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const stopped = screenStopped();
        try {
          const command = uploadCommand;
          agentScript = [{ commands: [command] }, { text: "Done." }];
          let race: Promise<string> | undefined;
          execHandlers.set(command, async ({ env }) => {
            const lock = await lockRun(id);
            // The Sprite has returned; the receipt arrives once the completion is waiting to commit.
            race = (async () => {
              try {
                await queued(completion);
                const result = receive(env, secret);
                await queued(receipt);
                await lock.release();
                return await result;
              } catch (error) {
                await lock.release().catch(() => {});
                throw error;
              }
            })();
            return output("uploaded");
          });
          const sent = await (await respond(id, id, owner, "Upload the flag")).done;
          await stopped.assertStopped(id);
          assert.equal(await race, "stale");
          const [uploader] = await operation(id, command);
          assert.equal(uploader.status, "completed");
          assert.equal(
            (await pool.query("SELECT 1 FROM ctf.flag_submissions WHERE game_id=$1", [id]))
              .rowCount,
            0,
          );
          assert.deepEqual(await run(id), {
            status: "active",
            submitted_flag_correct: null,
            generation: 0,
            promoted_at: null,
            correct: null,
            jobs: 0,
            submits: 0,
          });
          // With no receipt, play continues: the agent's next turn was admitted.
          assert.equal(agentRequests, 2);
          assert.ok(
            sent.some(
              ({ type, data }) => type === "event" && (data as { text: string }).text === "Done.",
            ),
          );
        } finally {
          stopped.restore();
        }
      },
    );

    await t.test(
      "a receipt that wins the race to the uploader's completion is promoted by that completion",
      async () => {
        const owner = `lifecycle-race-accepted-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const stopped = screenStopped();
        try {
          const command = uploadCommand;
          agentScript = [{ commands: [command] }];
          let race: Promise<string> | undefined;
          execHandlers.set(command, async ({ env }) => {
            const lock = await lockRun(id);
            const result = receive(env, secret);
            await queued(receipt);
            // The Sprite returns; the receipt commits after that and before the completion.
            race = (async () => {
              try {
                await queued(completion);
                await lock.release();
                return await result;
              } catch (error) {
                await lock.release().catch(() => {});
                throw error;
              }
            })();
            return output("uploaded");
          });
          await (
            await respond(id, id, owner, "Upload the flag")
          ).done;
          await stopped.assertStopped(id);
          assert.equal(await race, "accepted");
          const [uploader] = await operation(id, command);
          assert.equal(uploader.status, "completed");
          const promoted = await run(id);
          assert.ok(promoted.promoted_at);
          assert.deepEqual(
            { ...promoted, promoted_at: undefined },
            {
              status: "finalizing",
              submitted_flag_correct: true,
              generation: 1,
              promoted_at: undefined,
              correct: true,
              jobs: 1,
              submits: 1,
            },
          );
          assert.equal(agentRequests, 1);
        } finally {
          stopped.restore();
        }
      },
    );

    // docs/plans/stopped-command-settle.md: the worker settles a stopped command once its Sprite
    // lists no exec session, then promotes the receipts that were waiting on it.
    const spriteOf = (gameId: string) => `ctf-${gameId}`;
    const seedUnknown = async (gameId: string, startedAgo = "0 seconds") => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,
           command,status,output,started_at)
         VALUES($1,$2,$3,$3,$4,'command','sleep 60','unknown','Stopped.',now()-$5::interval)`,
        [id, spriteOf(gameId), gameId, randomUUID(), startedAgo],
      );
      return id;
    };
    const opState = async (id: string) =>
      (
        await pool.query<{ status: string; settled: boolean; output: string | null }>(
          "SELECT status,completed_at IS NOT NULL AS settled,output FROM ctf.sprite_operations WHERE id=$1",
          [id],
        )
      ).rows[0];
    const revision = async (gameId: string) =>
      Number(
        (await pool.query("SELECT state_revision FROM ctf.games WHERE id=$1", [gameId])).rows[0]
          .state_revision,
      );
    const emptySessions = (gameId: string) => sessionLists.set(spriteOf(gameId), async () => []);
    // A command the player stops: it records as unknown, and the run stays open.
    const stopDuringCommand = async (
      owner: string,
      gameId: string,
      command: string,
      seen?: (env: Record<string, string> | undefined) => void,
    ) => {
      agentScript = [{ commands: [command] }];
      execHandlers.set(command, async ({ env, signal }) => {
        seen?.(env);
        await requestSessionStop(gameId, gameId, owner);
        return untilAborted(signal);
      });
      await (
        await respond(gameId, gameId, owner, "Run it")
      ).done;
      const [stopped] = await operation(gameId, command);
      assert.equal(stopped.status, "unknown");
      return stopped.id;
    };
    const uploadAndReturn = async (owner: string, gameId: string, secret: string) => {
      agentScript = [{ commands: [uploadCommand] }];
      let accepted: string | undefined;
      execHandlers.set(uploadCommand, async ({ env }) => {
        accepted = await receive(env, secret);
        return output("uploaded");
      });
      await (
        await respond(gameId, gameId, owner, "Upload the flag")
      ).done;
      assert.equal(accepted, "accepted");
    };
    // A later pass, past the backoff a sprite earns when its last check failed or showed a session.
    const BACKOFF_PASS_MS = 11_000;
    const laterPass = (passes: number, onFailure = (_sprite: string, _error: unknown) => {}) =>
      settleStoppedCommands(onFailure, Date.now() + passes * BACKOFF_PASS_MS);
    const settleLogs = (own: { mock: typeof t.mock }) => {
      const spy = own.mock.method(console, "error");
      return () =>
        spy.mock.calls
          .map(({ arguments: [line] }) => String(line))
          .filter((line) => line.includes("monitor.settle.failed"))
          .map((line) => JSON.parse(line) as { event: string; spriteName: string });
    };

    await t.test(
      "S1: a stopped command on a Sprite with no session is settled, and a later upload is promoted",
      async () => {
        const owner = `settle-s1-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const stopped = await stopDuringCommand(owner, id, "sleep 60");
        emptySessions(id);
        const before = await revision(id);
        await runMonitorWorkerOnce();
        assert.deepEqual(listedSprites, [spriteOf(id)]);
        const { output: kept, ...settled } = await opState(stopped);
        assert.deepEqual(settled, { status: "interrupted", settled: true });
        assert.ok(kept, "the runner's output is kept");
        assert.ok((await revision(id)) > before, "open pages refresh");
        await uploadAndReturn(owner, id, secret);
        assert.equal((await run(id)).status, "finalizing");
        assert.ok((await run(id)).promoted_at);
      },
    );

    await t.test(
      "S2: a receipt waiting only on a stopped command is promoted by its settle",
      async () => {
        const owner = `settle-s2-${randomUUID()}`;
        const { id, secret } = await startRun(owner);
        const stopped = await stopDuringCommand(owner, id, "sleep 60");
        await uploadAndReturn(owner, id, secret);
        const pending = await run(id);
        assert.equal(pending.status, "active");
        assert.equal(pending.promoted_at, null);
        assert.equal((await opState(stopped)).status, "unknown");
        emptySessions(id);
        await runMonitorWorkerOnce();
        assert.equal((await opState(stopped)).status, "interrupted");
        const promoted = await run(id);
        assert.ok(promoted.promoted_at);
        assert.equal(promoted.status, "finalizing");
        assert.equal(promoted.generation, 1);
        assert.equal(promoted.submits, 1);
      },
    );

    await t.test("S3: a listed session blocks the settle, active or not", async () => {
      const { id } = await startRun(`settle-s3-${randomUUID()}`);
      const stopped = await seedUnknown(id);
      for (const [pass, isActive] of [true, false].entries()) {
        sessionLists.set(spriteOf(id), async () => [session(isActive)]);
        await laterPass(pass);
        assert.equal((await opState(stopped)).status, "unknown", `isActive ${isActive}`);
      }
      emptySessions(id);
      await laterPass(2);
      assert.equal((await opState(stopped)).status, "interrupted");
      assert.equal(listedSprites.length, 3);
    });

    await t.test(
      "S4 and S14: a failing list settles nothing there, logs, spares another Sprite, and is not retried inside the backoff",
      async (own) => {
        const failing = await startRun(`settle-s4-${randomUUID()}`);
        const healthy = await startRun(`settle-s4-${randomUUID()}`);
        const failed = await seedUnknown(failing.id, "2 minutes");
        const settled = await seedUnknown(healthy.id, "1 minute");
        sessionLists.set(spriteOf(failing.id), async () => {
          throw new TypeError("fetch failed");
        });
        emptySessions(healthy.id);
        const logs = settleLogs(own);
        await runMonitorWorkerOnce();
        assert.equal((await opState(failed)).status, "unknown");
        assert.equal((await opState(settled)).status, "interrupted");
        assert.deepEqual(
          logs().map(({ event, spriteName }) => ({ event, spriteName })),
          [{ event: "monitor.settle.failed", spriteName: spriteOf(failing.id) }],
        );
        // The failed Sprite is left alone for the backoff window, then checked again.
        await runMonitorWorkerOnce();
        assert.deepEqual(listedSprites.filter((name) => name === spriteOf(failing.id)).length, 1);
        emptySessions(failing.id);
        await laterPass(1);
        assert.equal((await opState(failed)).status, "interrupted");
        assert.equal(listedSprites.filter((name) => name === spriteOf(failing.id)).length, 2);
      },
    );

    await t.test(
      "S5: an operation that turns unknown during the list call is left alone",
      async () => {
        const { id } = await startRun(`settle-s5-${randomUUID()}`);
        const first = await seedUnknown(id);
        let late = "";
        sessionLists.set(spriteOf(id), async () => {
          late = await seedUnknown(id);
          return [];
        });
        await runMonitorWorkerOnce();
        assert.equal((await opState(first)).status, "interrupted");
        assert.equal((await opState(late)).status, "unknown");
        emptySessions(id);
        await runMonitorWorkerOnce();
        assert.equal((await opState(late)).status, "interrupted");
      },
    );

    await t.test(
      "S6: a resolved operation, a deleted sandbox and an open delete are left alone",
      async () => {
        const resolved = await startRun(`settle-s6-${randomUUID()}`);
        const deletedRun = await startRun(`settle-s6-${randomUUID()}`);
        const deleting = await startRun(`settle-s6-${randomUUID()}`);
        const done = await seedUnknown(resolved.id);
        const gone = await seedUnknown(deletedRun.id);
        const held = await seedUnknown(deleting.id);
        await pool.query("UPDATE ctf.games SET sprite_deleted_at=now() WHERE id=$1", [
          deletedRun.id,
        ]);
        await pool.query(
          `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,kind,status)
         VALUES($1,$2,$3,'delete','running')`,
          [randomUUID(), spriteOf(deleting.id), deleting.id],
        );
        sessionLists.set(spriteOf(resolved.id), async () => {
          await pool.query(
            "UPDATE ctf.sprite_operations SET status='completed',completed_at=now() WHERE id=$1",
            [done],
          );
          return [];
        });
        await runMonitorWorkerOnce();
        assert.equal((await opState(done)).status, "completed");
        assert.equal((await opState(gone)).status, "unknown");
        assert.equal((await opState(held)).status, "unknown");
        assert.deepEqual(listedSprites, [spriteOf(resolved.id)]);
      },
    );

    await t.test(
      "S7: a settled command's receipt stays unpromoted, and its token is refused when it had none",
      async () => {
        const owner = `settle-s7-${randomUUID()}`;
        const withReceipt = await startRun(owner);
        const command = uploadCommand;
        agentScript = [{ commands: [command] }];
        let accepted: string | undefined;
        execHandlers.set(command, async ({ env, signal }) => {
          accepted = await receive(env, withReceipt.secret);
          await requestSessionStop(withReceipt.id, withReceipt.id, owner);
          return untilAborted(signal);
        });
        await (
          await respond(withReceipt.id, withReceipt.id, owner, "Upload the flag")
        ).done;
        assert.equal(accepted, "accepted");
        emptySessions(withReceipt.id);
        await runMonitorWorkerOnce();
        const [uploader] = await operation(withReceipt.id, command);
        assert.equal(uploader.status, "interrupted");
        const after = await run(withReceipt.id);
        assert.equal(after.status, "active");
        assert.equal(after.promoted_at, null);
        assert.equal(after.jobs, 0);
        // Nothing the settled command's receipt could do: the run stays unscored.
        await runMonitorWorkerOnce();
        assert.equal((await run(withReceipt.id)).status, "active");

        const owner2 = `settle-s7b-${randomUUID()}`;
        const bare = await startRun(owner2);
        let target: Record<string, string> | undefined;
        await stopDuringCommand(owner2, bare.id, "sleep 60", (env) => (target = env));
        emptySessions(bare.id);
        await runMonitorWorkerOnce();
        assert.equal(await receive(target, bare.secret), "stale");
        assert.equal((await run(bare.id)).correct, null);
      },
    );

    await t.test("S8: two runs on one Sprite are both bumped and promoted", async () => {
      const owner = `settle-s8-${randomUUID()}`;
      const first = await startRun(owner);
      const stopped = await stopDuringCommand(owner, first.id, "sleep 60");
      await uploadAndReturn(owner, first.id, first.secret);
      // A second run on the same Sprite, with its own stopped command and its own pending receipt.
      const secondId = randomUUID();
      await pool.query(
        `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
           monitor_version,token_budget,status,monitor_mode,submission_transport,bug_fix_required)
         SELECT $2,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,
           token_budget,'active','async','http',false FROM ctf.games WHERE id=$1`,
        [first.id, secondId],
      );
      await pool.query(
        `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt)
         SELECT $2,$2,1,agent_model,agent_effort,system_prompt FROM ctf.agent_sessions WHERE id=$1`,
        [first.id, secondId],
      );
      const secondStopped = randomUUID();
      const secondUploader = randomUUID();
      for (const [opId, command, status] of [
        [secondStopped, "sleep 60", "unknown"],
        [secondUploader, "upload", "completed"],
      ])
        await pool.query(
          `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,
             command,status,output)
           VALUES($1,$2,$3,$3,$4,'command',$5,$6,'uploaded')`,
          [opId, spriteOf(first.id), secondId, randomUUID(), command, status],
        );
      await pool.query(
        "INSERT INTO ctf.flag_submissions(game_id,operation_id,body_hash,correct) VALUES($1,$2,$3,true)",
        [secondId, secondUploader, "a".repeat(64)],
      );
      const before = [await revision(first.id), await revision(secondId)];
      sessionLists.set(spriteOf(first.id), async () => []);
      await runMonitorWorkerOnce();
      for (const op of [stopped, secondStopped])
        assert.equal((await opState(op)).status, "interrupted");
      assert.ok((await revision(first.id)) > before[0]);
      assert.ok((await revision(secondId)) > before[1]);
      for (const gameId of [first.id, secondId]) {
        assert.ok((await run(gameId)).promoted_at, gameId);
        assert.equal((await run(gameId)).generation, 1, gameId);
      }
    });

    await t.test("S9: two passes at once settle each operation once", async () => {
      const { id } = await startRun(`settle-s9-${randomUUID()}`);
      const stopped = await seedUnknown(id);
      emptySessions(id);
      const before = await revision(id);
      await Promise.all([runMonitorWorkerOnce(), runMonitorWorkerOnce()]);
      assert.equal((await opState(stopped)).status, "interrupted");
      assert.equal(await revision(id), before + 1);
    });

    await t.test(
      "S10: a finalizing run behind a stopped command is claimed in the same pass",
      async () => {
        const { id } = await startRun(`settle-s10-${randomUUID()}`);
        await pool.query(
          `UPDATE ctf.games SET status='finalizing',submitted_flag_correct=false,
           submitted_session_id=$1,monitor_mode='async',submission_transport='tool' WHERE id=$1`,
          [id],
        );
        await pool.query("INSERT INTO ctf.finalization_jobs(game_id) VALUES($1)", [id]);
        const stopped = await seedUnknown(id);
        emptySessions(id);
        assert.equal(await runMonitorWorkerOnce(), true);
        assert.equal((await opState(stopped)).status, "interrupted");
        assert.equal((await run(id)).status, "ended");
      },
    );

    await t.test(
      "S11: the run view stops reporting an unconfirmed monitor once settled",
      async () => {
        const owner = `settle-s11-${randomUUID()}`;
        const { id } = await startRun(owner);
        const view = async () => (await publicGame(await getGame(id, owner))).monitor?.status;
        await seedUnknown(id);
        assert.equal(await view(), "unresolved");
        emptySessions(id);
        await runMonitorWorkerOnce();
        assert.equal(await view(), "caught-up");
      },
    );

    await t.test(
      "S12: every candidate Sprite is checked in one pass, and a failing one blocks no other",
      async () => {
        const runs = [];
        for (const age of ["4 minutes", "3 minutes", "2 minutes", "1 minute"]) {
          const { id } = await startRun(`settle-s12-${randomUUID()}`);
          runs.push({ id, op: await seedUnknown(id, age) });
        }
        sessionLists.set(spriteOf(runs[0].id), async () => {
          throw new TypeError("fetch failed");
        });
        for (const { id } of runs.slice(1)) emptySessions(id);
        await runMonitorWorkerOnce();
        assert.deepEqual([...listedSprites].sort(), runs.map(({ id }) => spriteOf(id)).sort());
        assert.equal((await opState(runs[0].op)).status, "unknown");
        for (const { op } of runs.slice(1)) assert.equal((await opState(op)).status, "interrupted");
      },
    );

    await t.test("S13: pending work includes a stopped command until it is settled", async () => {
      const { id } = await startRun(`settle-s13-${randomUUID()}`);
      assert.equal(await hasPendingWork(), false);
      const stopped = await seedUnknown(id);
      assert.equal(await hasPendingWork(), true);
      emptySessions(id);
      await runMonitorWorkerOnce();
      assert.equal((await opState(stopped)).status, "interrupted");
      assert.equal(await hasPendingWork(), false);
      await seedUnknown(id);
      await pool.query("UPDATE ctf.games SET sprite_deleted_at=now() WHERE id=$1", [id]);
      assert.equal(await hasPendingWork(), false, "a deleted sandbox has nothing to settle");
      const { id: deleting } = await startRun(`settle-s13-${randomUUID()}`);
      await seedUnknown(deleting);
      assert.equal(await hasPendingWork(), true);
      await pool.query(
        `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,kind,status)
         VALUES($1,$2,$3,'delete','running')`,
        [randomUUID(), spriteOf(deleting), deleting],
      );
      assert.equal(await hasPendingWork(), false, "an open delete leaves nothing to settle");
    });
  },
);
