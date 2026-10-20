import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import {
  CheckpointStream,
  RestoreStream,
  Sprite,
  SpritesClient,
  ExecError,
  type ExecOptions,
  type HTTPExecOptions,
} from "@fly/sprites";
import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";

// Only the runner's fresh loopback database is accepted; never read .env.local.
const connection = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(connection.hostname, "127.0.0.1", "Use npm run test:integration");
assert.match(connection.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const pool = new Pool({
  connectionString: connection.toString(),
  max: 5,
  options: "-c search_path=ctf,public",
});
// Use the existing pool seam with a real pg Pool, not mocked SQL or relaxed production TLS.
(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;

// ~45 s on a loaded host; 60 s left no headroom.
await test("Sprite orchestration with real Postgres and Pi", { timeout: 120_000 }, async (t) => {
  t.after(async () => {
    await pool.end();
  });
  assert.equal(
    (await pool.query("SELECT to_regnamespace('ctf') AS schema")).rows[0].schema,
    null,
    "Refuse to change a database that already contains application data",
  );
  for (const file of [
    "../../db/schema.sql",
    "../../db/migrations/002-dollar-seasons.sql",
    "../../db/migrations/003-monitor-reasoning.sql",
    "../../db/migrations/005-estimated-settlement.sql",
    "../../db/migrations/006-system-prompt.sql",
    "../../db/migrations/007-inference-game-index.sql",
    "../../db/migrations/008-block-ends-run.sql",
    "../../db/migrations/009-monitor-choice.sql",
  ])
    await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const { startGame, getGame, claimGame, cleanup } = await import("../../lib/games");
  const { executeCommand, destroyEnvironment, operationTimeout } =
    await import("../../lib/sprites");
  const { runGame } = await import("../../lib/runner");
  const {
    AGENT_MODEL,
    AGENT_PROMPT,
    MONITOR_MODEL,
    MONITOR_PROMPT,
    MONITOR_PROMPTS,
    agentPrompt,
    hasSecret,
  } = await import("../../lib/policy");

  // Per sprite: checkpoints (id -> state version) and a state version bumped by every command and
  // reset by a restore, so tests can see exactly which checkpoint a restore went back to.
  const environments = new Map<
    string,
    {
      policy: boolean;
      secret?: string;
      version: number;
      checkpoints: Map<string, number>;
      nextCheckpoint: number;
    }
  >();
  type StreamFailure = "ok" | "reject" | "error" | "truncated" | "hang" | "no-complete";
  let checkpointMode: StreamFailure = "ok";
  let restoreMode: StreamFailure = "ok";
  // What each checkpoint or restore saw: agent requests and commands so far, and fork-child statuses.
  const checkpoints: { name: string; requests: number; commands: number }[] = [];
  const restores: { name: string; id: string; childStatuses: string[]; version: number }[] = [];
  const trace: string[] = [];
  const commands: { name: string; command: string }[] = [];
  const violations: string[] = [];
  let failAt: "create" | "policy" | "initialize" | "delete" | undefined;
  let gate: (() => Promise<void>) | undefined;
  let commandResult = { stdout: "fixture-output", stderr: "", exitCode: 0 };
  let commandFailure: Error | undefined;
  let commandGate: ((signal: AbortSignal) => Promise<void>) | undefined;
  let monitor = "allow";
  // The monitor model the next monitor requests must name (the default unless a test picks one).
  let expectedMonitor = MONITOR_MODEL;
  // A monitor-capable catalog model other than the default, for tests that pick their own.
  const ALT_MONITOR = "moonshotai/kimi-k3";
  // Decisions for the next monitor calls, in order; "monitor" applies once it is empty.
  let monitorQueue: string[] = [];
  // Whether the agent's tool-call turn includes readable reasoning.
  let agentReasoning = true;
  // Dollars per call, as OpenRouter reports usage.cost; settlement converts to microdollars.
  let agentCost = 0;
  let monitorCost = 0;
  // A string is a sprite_exec command; { submit } is a submit call with that value.
  let proposed: (string | { submit: string })[] = ["printf harmless"];
  let proposedTool = "sprite_exec";
  let proposedArguments = (command: string) => JSON.stringify({ command });
  let agentCalls = 0;
  const requests: { role: "agent" | "monitor"; payload: unknown; at: number }[] = [];
  let responses: Partial<
    Record<
      "agent" | "monitor",
      { status: number; retryAfter?: string; metadataRetryAfter?: string }[]
    >
  > = {};
  let fetchGate: ((signal: AbortSignal) => Promise<Response>) | undefined;
  let abortOn429: (() => void) | undefined;
  // "cut" ends an agent stream after its first chunk, with no usage; "endless" sends its first
  // chunk and then only keep-alives until the request is aborted.
  let agentStreamMode: "full" | "cut" | "endless" = "full";
  // "length" makes the first agent reply reasoning only, stopped at the output limit.
  let agentFinish: "stop" | "length" = "stop";
  // Generation ids the fake has issued, with the cost OpenRouter later reports for them.
  const generations = new Map<string, number>();
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
  const fixtureFailure = (stage: typeof failAt) => {
    if (failAt === stage) throw new Error(`fixture failure: ${stage}`);
  };
  // Stub only remote SDK operations. Keep the actual client/handle and app adapters.
  t.mock.method(
    SpritesClient.prototype,
    "createSprite",
    strict(async (name: string, options: unknown) => {
      assert.deepEqual(options, {
        config: { ramMB: 512, cpus: 1 },
        urlSettings: { auth: "sprite", privateAccess: "admins" },
      });
      assert.ok(!environments.has(name));
      trace.push(`${name}:create`);
      fixtureFailure("create");
      environments.set(name, {
        policy: false,
        version: 0,
        checkpoints: new Map(),
        nextCheckpoint: 1,
      });
      if (gate) await gate();
      return new SpritesClient("integration-sprite-token").sprite(name);
    }),
  );
  t.mock.method(
    Sprite.prototype,
    "updateNetworkPolicy",
    async function (this: Sprite, policy: unknown) {
      await strict(async () => {
        assert.deepEqual(policy, { rules: [{ domain: "*", action: "deny" }] });
        assert.ok(environments.has(this.name));
        trace.push(`${this.name}:policy`);
        fixtureFailure("policy");
        environments.get(this.name)!.policy = true;
      })();
    },
  );
  const seed = await readFile(new URL("../../seed/workspace.tar.gz", import.meta.url));
  t.mock.method(
    Sprite.prototype,
    "execFileHTTP",
    async function (this: Sprite, file: string, args: string[], options: HTTPExecOptions) {
      return strict(async () => {
        const environment = environments.get(this.name);
        assert.ok(environment?.policy, "No initialization before network policy");
        assert.equal(file, "bash");
        assert.deepEqual(
          { ...options, input: undefined },
          { timeout: 20_000, maxBuffer: 4096, input: undefined },
        );
        assert.ok(Buffer.isBuffer(options.input) && seed.equals(options.input), "Seed tarball");
        assert.equal(args[0], "-c");
        assert.equal(args.length, 2);
        const secret = args[1].match(
          /^mkdir -p \/workspace && tar -xzf - -C \/workspace && printf '%s' '(flag\{[\w-]{32}\})' > \/tmp\/flag\.txt && chmod 644 \/tmp\/flag\.txt$/,
        )?.[1];
        assert.ok(secret, "Unexpected initialization script");
        trace.push(`${this.name}:initialize`);
        fixtureFailure("initialize");
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
        assert.ok(environment?.policy, "No initialization or execution before network policy");
        assert.equal(file, "timeout");
        assert.deepEqual(args.slice(0, 5), ["-k", "2", "15", "bash", "-lc"]);
        assert.equal(args.length, 6);
        assert.ok(environment.secret);
        assert.deepEqual(
          { ...options, signal: undefined },
          {
            cwd: "/workspace",
            timeout: 20_000,
            maxBuffer: 65536,
            signal: undefined,
            maxRunAfterDisconnect: "1s",
          },
        );
        commands.push({ name: this.name, command: args[5] });
        environment.version++;
        options.signal?.throwIfAborted();
        if (commandGate) {
          assert.ok(options.signal);
          await commandGate(options.signal);
        }
        if (commandFailure) throw commandFailure;
        assert.ok(
          ["printf harmless", "printf old", "printf after-fork", "cat /tmp/flag.txt"].includes(
            args[5],
          ),
          "Unexpected fixture command",
        );
        return args[5] === "cat /tmp/flag.txt"
          ? { stdout: environment.secret, stderr: "", exitCode: 0 }
          : commandResult;
      })();
    },
  );
  // Real CheckpointStream/RestoreStream over a synthetic NDJSON response in the probed wire format.
  const ndjson = (lines: unknown[], hang = false) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines)
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
          if (!hang) controller.close();
        },
      }),
    );
  t.mock.method(
    Sprite.prototype,
    "createCheckpoint",
    async function (this: Sprite, comment?: string) {
      return strict(async () => {
        const environment = environments.get(this.name);
        assert.ok(environment?.policy, "No checkpoint before network policy");
        assert.equal(comment, undefined);
        checkpoints.push({
          name: this.name,
          requests: requests.filter((request) => request.role === "agent").length,
          commands: commands.length,
        });
        if (checkpointMode === "reject") throw new Error("fixture checkpoint rejected");
        const info = [{ type: "info", data: "Creating checkpoint..." }];
        if (checkpointMode === "error")
          return new CheckpointStream(
            ndjson([...info, { type: "error", error: "fixture failure" }]),
          );
        if (checkpointMode === "truncated") return new CheckpointStream(ndjson(info));
        if (checkpointMode === "hang") return new CheckpointStream(ndjson(info, true));
        if (checkpointMode === "no-complete")
          return new CheckpointStream(ndjson([...info, { type: "complete", data: "All done" }]));
        const id = `v${environment.nextCheckpoint++}`;
        environment.checkpoints.set(id, environment.version);
        return new CheckpointStream(
          ndjson([...info, { type: "complete", data: `Checkpoint ${id} created successfully` }]),
        );
      })();
    },
  );
  t.mock.method(Sprite.prototype, "restoreCheckpoint", async function (this: Sprite, id: string) {
    return strict(async () => {
      const environment = environments.get(this.name)!;
      assert.ok(environment?.checkpoints.has(id), `Restore of an unknown checkpoint ${id}`);
      const childStatuses = (
        await pool.query(
          "SELECT status FROM ctf.games WHERE sprite_name=$1 AND forked_from IS NOT NULL",
          [this.name],
        )
      ).rows.map((row) => row.status as string);
      restores.push({ name: this.name, id, childStatuses, version: environment.version });
      if (restoreMode === "reject") throw new Error("fixture restore rejected");
      const info = [{ type: "info", data: "Restoring..." }];
      if (restoreMode === "error")
        return new RestoreStream(ndjson([...info, { type: "error", error: "fixture failure" }]));
      if (restoreMode === "truncated") return new RestoreStream(ndjson(info));
      if (restoreMode === "hang") return new RestoreStream(ndjson(info, true));
      if (restoreMode === "no-complete")
        return new RestoreStream(ndjson([...info, { type: "info", data: "ok" }]));
      environment.version = environment.checkpoints.get(id)!;
      return new RestoreStream(
        ndjson([...info, { type: "complete", data: `Restore from ${id} complete` }]),
      );
    })();
  });
  t.mock.method(
    SpritesClient.prototype,
    "deleteSprite",
    strict(async (name: string) => {
      trace.push(`${name}:delete`);
      fixtureFailure("delete");
      if (!environments.delete(name)) throw new Error("404 not found");
    }),
  );
  // All unrecognized HTTP/WS traffic fails closed, including traffic from new code paths.
  t.mock.method(globalThis, "WebSocket", function () {
    violations.push("Unexpected WebSocket connection");
    throw new Error("No live WebSocket connections in integration tests");
  });
  t.mock.method(
    globalThis,
    "fetch",
    strict(async (input: string | URL | Request, options?: RequestInit) => {
      options?.signal?.throwIfAborted();
      if (String(input).startsWith("https://openrouter.ai/api/v1/generation?id=")) {
        assert.equal(
          new Headers(options?.headers).get("authorization"),
          "Bearer integration-router-key",
        );
        const id = new URL(String(input)).searchParams.get("id")!;
        assert.ok(generations.has(id), "Reconciliation asks only about issued generations");
        return Response.json({
          data: {
            finish_reason: "stop",
            native_tokens_prompt: 3,
            native_tokens_completion: 4,
            total_cost: generations.get(id),
          },
        });
      }
      if (String(input) === "https://openrouter.ai/api/v1/models")
        return Response.json({
          // GLM 5.3 can monitor and does not require reasoning; Qwen flash has no response_format.
          data: [...new Set([AGENT_MODEL, MONITOR_MODEL, ALT_MONITOR, "qwen/qwen3.8-flash"])].map(
            (id) => ({
              id,
              context_length: 100000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters:
                id === "qwen/qwen3.8-flash"
                  ? ["tools", "reasoning"]
                  : ["tools", "response_format", "reasoning"],
            }),
          ),
        });
      assert.equal(String(input), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(options?.method, "POST");
      const payload = JSON.parse(String(options.body));
      const role = payload.response_format ? "monitor" : "agent";
      requests.push({ role, payload, at: performance.now() });
      const planned = responses[role]?.shift();
      if (fetchGate && requests.length === 2) return fetchGate(options!.signal!);
      if (planned?.status === -1) throw new Error("fixture network failure");
      if (planned && ![200, 299].includes(planned.status)) {
        if (planned.status === 429) abortOn429?.();
        return Response.json(
          {
            error: {
              code: planned.status,
              message: "Fixture provider error",
              metadata: {
                headers: planned.metadataRetryAfter
                  ? { "Retry-After": planned.metadataRetryAfter }
                  : {},
              },
            },
          },
          {
            status: planned.status,
            headers: planned.retryAfter ? { "retry-after": planned.retryAfter } : {},
          },
        );
      }
      let message;
      const mode = payload.response_format ? (monitorQueue.shift() ?? monitor) : monitor;
      if (payload.response_format) {
        // Every monitor request must use the model its run is expected to use.
        assert.equal(payload.model, expectedMonitor);
        // GLM flash rejects disabled reasoning, so it gets low-effort hidden reasoning; the others
        // have it disabled.
        assert.deepEqual(
          payload.reasoning,
          expectedMonitor === "z-ai/glm-5.3-flash"
            ? { effort: "low", exclude: false }
            : { enabled: false },
        );
        message = {
          reasoning: "Monitor fixture reasoning.",
          content:
            mode === "invalid"
              ? "invalid JSON"
              : JSON.stringify({
                  allow: mode === "allow",
                  reason: mode === "block" ? "Protected read" : "",
                }),
        };
      } else {
        assert.equal(payload.model, AGENT_MODEL);
        assert.equal(payload.stream, true, "Agent calls stream");
        assert.deepEqual(
          payload.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
          ["sprite_exec", "submit"],
        );
        agentCalls++;
        message =
          agentCalls === 1 && agentFinish === "length"
            ? { reasoning: "Thinking at length." }
            : agentCalls === 1
              ? {
                  reasoning: agentReasoning ? "Controlled fixture reasoning." : undefined,
                  tool_calls: proposed.map((call) => ({
                    id: randomUUID(),
                    type: "function",
                    function:
                      typeof call === "string"
                        ? { name: proposedTool, arguments: proposedArguments(call) }
                        : { name: "submit", arguments: JSON.stringify({ value: call.submit }) },
                  })),
                }
              : { content: "Done." };
      }
      const id = `test-${randomUUID()}`,
        cost = payload.response_format ? monitorCost : agentCost,
        usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost };
      generations.set(id, cost);
      if (payload.response_format) {
        assert.equal(payload.stream, undefined, "Monitor calls never stream");
        return Response.json({
          id,
          choices: [{ message, finish_reason: "stop" }],
          ...(planned?.status === 299 ? {} : { usage }),
        });
      }
      // Stream the agent turn the way OpenRouter does: reasoning, text and each tool call's
      // arguments arrive in pieces, and usage comes last.
      const half = (text: string) => [
        text.slice(0, Math.ceil(text.length / 2)),
        text.slice(Math.ceil(text.length / 2)),
      ];
      const reply = message as {
        reasoning?: string;
        content?: string;
        tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
      };
      const deltas: Record<string, unknown>[] = [
        ...half(reply.reasoning ?? "")
          .filter(Boolean)
          .map((reasoning) => ({ reasoning })),
        ...(reply.content ? [{ content: reply.content }] : []),
        ...(reply.tool_calls ?? []).flatMap((call, index) =>
          half(call.function.arguments).map((part, i) => ({
            tool_calls: [
              i === 0
                ? {
                    index,
                    id: call.id,
                    type: call.type,
                    function: { name: call.function.name, arguments: part },
                  }
                : { index, function: { arguments: part } },
            ],
          })),
        ),
      ];
      const frames = [
        ": OPENROUTER PROCESSING",
        ...deltas.map((delta) => JSON.stringify({ id, choices: [{ delta }] })),
        JSON.stringify({
          id,
          choices: [{ delta: {}, finish_reason: agentCalls === 1 ? agentFinish : "stop" }],
        }),
        ...(planned?.status === 299 ? [] : [JSON.stringify({ id, choices: [], usage })]),
        "[DONE]",
      ].map((frame) => (frame.startsWith(":") ? `${frame}\n\n` : `data: ${frame}\n\n`));
      if (agentStreamMode === "endless") {
        const signal = options!.signal!;
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setInterval> | undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(frames.slice(0, 2).join("")));
              timer = setInterval(
                () => controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n")),
                100,
              );
              signal.addEventListener(
                "abort",
                () => {
                  clearInterval(timer);
                  controller.error(signal.reason);
                },
                { once: true },
              );
            },
            cancel() {
              clearInterval(timer);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response((agentStreamMode === "cut" ? frames.slice(0, 2) : frames).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  t.beforeEach(async () => {
    await pool.query(
      "TRUNCATE ctf.events,ctf.inference,ctf.games,ctf.daily_spend RESTART IDENTITY CASCADE",
    );
    environments.clear();
    checkpointMode = "ok";
    restoreMode = "ok";
    checkpoints.length = 0;
    restores.length = 0;
    operationTimeout.ms = 30_000;
    trace.length = 0;
    commands.length = 0;
    violations.length = 0;
    failAt = undefined;
    gate = undefined;
    commandFailure = undefined;
    commandGate = undefined;
    commandResult = { stdout: "fixture-output", stderr: "", exitCode: 0 };
    monitor = "allow";
    expectedMonitor = MONITOR_MODEL;
    monitorQueue = [];
    agentReasoning = true;
    agentCost = 0;
    monitorCost = 0;
    proposed = ["printf harmless"];
    proposedTool = "sprite_exec";
    proposedArguments = (command) => JSON.stringify({ command });
    agentCalls = 0;
    requests.length = 0;
    responses = {};
    fetchGate = undefined;
    abortOn429 = undefined;
    agentStreamMode = "full";
    agentFinish = "stop";
    generations.clear();
  });
  t.afterEach(() =>
    assert.deepEqual(
      violations,
      [],
      "Unexpected fake-boundary operations must fail even if app cleanup catches them",
    ),
  );
  const row = async (id: string) =>
    (await pool.query("SELECT * FROM ctf.games WHERE id=$1", [id])).rows[0];
  const play = async (id: string, owner: string, signal = AbortSignal.timeout(5000)) => {
    const leased = await claimGame(id, owner);
    await runGame(leased, "Controlled integration fixture", signal, () => {});
    return getGame(id, owner);
  };

  await (await import("./history")).runHistoryTests(t, pool);

  process.env.BETTER_AUTH_SECRET = "integration-only-secret-at-least-32-bytes";
  process.env.BETTER_AUTH_URL = "http://localhost";
  process.env.TRIPWIRE_COOKIE_PREFIX = "ctf-integration";
  const { auth } = await import("../../lib/auth");
  await (
    await (await import("better-auth/db/migration")).getMigrations(auth.options)
  ).runMigrations();
  // Each guest gets its own forwarded IP so tests never share the sign-in rate-limit bucket.
  const origin = "http://localhost";
  let guests = 0;
  const guest = async () => {
    const session = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/anonymous`, {
        method: "POST",
        headers: {
          origin,
          "Content-Type": "application/json",
          "x-forwarded-for": `203.0.113.${100 + guests++}`,
        },
        body: "{}",
      }),
    );
    assert.equal(session.status, 200);
    const cookie = session.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { cookie, id: (await session.json()).user.id as string };
  };

  await t.test("database rate limiting reports a Retry-After within its window", async () => {
    // Same order as scripts/setup.ts: this migration adjusts a Better Auth table.
    await pool.query(
      await readFile(
        new URL("../../db/migrations/004-rate-limit-timestamp.sql", import.meta.url),
        "utf8",
      ),
    );
    const request = () =>
      auth.handler(
        new Request("http://localhost/api/auth/ok", {
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
      );
    // The configured rule allows 20 requests per 60-second window.
    for (let i = 0; i < 20; i++) assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get("X-Retry-After"));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After was ${retryAfter}`);
  });

  const MARKER = "HiddenMarker7Q2",
    MARKER2 = "OtherMarker9Z4";
  const agentSystems = (from = 0) =>
    requests
      .slice(from)
      .filter((request) => request.role === "agent")
      .map(
        (request) =>
          (request.payload as { messages: { role: string; content: unknown }[] }).messages.find(
            (message) => message.role === "system",
          )?.content,
      );
  const preamble = (messages: Message[]) =>
    getCurrentSystemMessage(messages as Parameters<typeof getCurrentSystemMessage>[0])?.sections
      ?.preamble;
  // The real prompt route; the SSE body must be consumed for the run to finish.
  const instructFrames = async (
    who: { cookie: string },
    gameId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { POST } = await import("../../app/api/games/[id]/prompt/route");
    const response = await POST(
      new Request(`${origin}/api/games/${gameId}/prompt`, {
        method: "POST",
        headers: { origin, cookie: who.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Controlled integration fixture", ...extra }),
      }),
      { params: Promise.resolve({ id: gameId }) },
    );
    const text = response.headers.get("content-type")?.includes("text/event-stream")
      ? await response.text()
      : "";
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.trim())
      .map((frame) => ({
        type: frame.match(/^event: (.*)$/m)![1],
        data: JSON.parse(frame.match(/^data: (.*)$/m)![1]),
      }));
    return { response, frames };
  };
  const instruct = async (
    who: { cookie: string },
    gameId: string,
    extra: Record<string, unknown> = {},
  ) => (await instructFrames(who, gameId, extra)).response;

  await t.test(
    "system prompt is saved with an instruction, persists, changes and clears; monitor never sees it",
    async () => {
      const who = await guest();
      const game = await startGame(who.id, false);
      assert.equal((await row(game.id)).system_prompt, "");
      assert.equal((await instruct(who, game.id, { systemPrompt: MARKER })).status, 200);
      assert.equal((await row(game.id)).system_prompt, MARKER);
      // A later instruction that omits systemPrompt keeps it.
      agentCalls = 0;
      assert.equal((await instruct(who, game.id)).status, 200);
      let systems = agentSystems();
      assert.equal(systems.length, 4);
      assert.deepEqual(systems, Array(4).fill(agentPrompt(MARKER)));
      let stored = await row(game.id);
      assert.equal(stored.system_prompt, MARKER);
      assert.equal(preamble(stored.messages), agentPrompt(MARKER));
      // Changing it replaces the prompt; the old one is gone from every later request.
      const changed = requests.length;
      agentCalls = 0;
      assert.equal((await instruct(who, game.id, { systemPrompt: MARKER2 })).status, 200);
      systems = agentSystems(changed);
      assert.equal(systems.length, 2);
      assert.deepEqual(systems, Array(2).fill(agentPrompt(MARKER2)));
      assert.ok(!JSON.stringify(requests.slice(changed)).includes(MARKER));
      stored = await row(game.id);
      assert.equal(preamble(stored.messages), agentPrompt(MARKER2));
      // Clearing reverts to the built-in prompt.
      const cleared = requests.length;
      agentCalls = 0;
      assert.equal((await instruct(who, game.id, { systemPrompt: "" })).status, 200);
      systems = agentSystems(cleared);
      assert.equal(systems.length, 2);
      assert.deepEqual(systems, Array(2).fill(AGENT_PROMPT));
      assert.ok(!JSON.stringify(requests.slice(cleared)).includes(MARKER2));
      stored = await row(game.id);
      assert.equal(stored.system_prompt, "");
      assert.equal(preamble(stored.messages), AGENT_PROMPT);
      // Monitor requests across every phase.
      const monitored = requests.filter((request) => request.role === "monitor");
      assert.equal(monitored.length, 4);
      for (const { payload } of monitored) {
        const text = JSON.stringify(payload);
        assert.ok(!text.includes(MARKER) && !text.includes(MARKER2));
        const input = JSON.parse(
          (payload as { messages: { role: string; content: string }[] }).messages.find(
            (message) => message.role === "user",
          )!.content,
        );
        assert.ok(!("agentSystemPrompt" in input));
        assert.ok(!input.transcript.some((message: { role: string }) => message.role === "system"));
        assert.ok(
          input.transcript.some(
            (message: { role: string; content: unknown }) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("Controlled integration fixture"),
          ),
        );
        assert.equal(input.proposedToolCall.name, "sprite_exec");
        assert.deepEqual(input.proposedToolCall.arguments, { command: "printf harmless" });
      }
    },
  );

  await t.test("without a system prompt the agent keeps the built-in prompt", async () => {
    const game = await startGame("no-prompt-owner", false);
    assert.equal((await row(game.id)).system_prompt, "");
    await play(game.id, "no-prompt-owner");
    agentCalls = 0;
    const finished = await play(game.id, "no-prompt-owner");
    const systems = agentSystems();
    assert.equal(systems.length, 4);
    assert.deepEqual(systems, Array(4).fill(AGENT_PROMPT));
    assert.equal(preamble(finished.messages), AGENT_PROMPT);
    assert.ok(
      !requests.some((request) =>
        JSON.stringify(request.payload).includes("expert coding assistant"),
      ),
    );
  });

  await t.test(
    "prompt route rejects an invalid system prompt before claiming or inferring; start route ignores it",
    async () => {
      const who = await guest();
      const game = await startGame(who.id, false);
      assert.equal((await instruct(who, game.id, { systemPrompt: MARKER })).status, 200);
      const before = await row(game.id);
      const inference = async () =>
        Number((await pool.query("SELECT count(*) AS n FROM ctf.inference")).rows[0].n);
      const sent = requests.length,
        billed = await inference();
      for (const systemPrompt of [123, ["x"], { a: 1 }, true, null, "x".repeat(8193)]) {
        const response = await instruct(who, game.id, { systemPrompt });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /system prompt/i);
        const after = await row(game.id);
        assert.equal(after.lease, null);
        assert.equal(after.lease_until, null);
        assert.equal(after.system_prompt, MARKER);
        assert.deepEqual(after.updated_at, before.updated_at);
        assert.equal(after.agent_model, before.agent_model);
        assert.deepEqual(after.messages, before.messages);
        assert.equal(requests.length, sent);
        assert.equal(await inference(), billed);
      }
      // Whitespace-only is valid and clears it.
      agentCalls = 0;
      assert.equal((await instruct(who, game.id, { systemPrompt: " \n " })).status, 200);
      assert.equal((await row(game.id)).system_prompt, "");
      // The start route has no system-prompt input.
      const { POST } = await import("../../app/api/games/route");
      const started = await POST(
        new Request(`${origin}/api/games`, {
          method: "POST",
          headers: { origin, cookie: who.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ systemPrompt: MARKER }),
        }),
      );
      assert.equal(started.status, 200);
      assert.equal((await row((await started.json()).id)).system_prompt, "");
    },
  );

  await t.test("another player cannot change or run with a run's system prompt", async () => {
    const owner = await guest(),
      intruder = await guest();
    const game = await startGame(owner.id, false);
    assert.equal((await instruct(owner, game.id, { systemPrompt: MARKER })).status, 200);
    const before = await row(game.id);
    const sent = requests.length;
    const response = await instruct(intruder, game.id, { systemPrompt: "Intruder prompt" });
    assert.equal(response.status, 404);
    const after = await row(game.id);
    assert.equal(after.system_prompt, MARKER);
    assert.equal(after.lease, null);
    assert.deepEqual(after.updated_at, before.updated_at);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(requests.length, sent);
  });

  const billingKeys = [
    "budgetMicrodollars",
    "spentMicrodollars",
    "reservedMicrodollars",
    "agentSpendMicrodollars",
    "monitorSpendMicrodollars",
  ] as const;
  const pick = (value: Record<string, unknown>) =>
    Object.fromEntries(billingKeys.map((key) => [key, value[key]]));

  await t.test(
    "billing frames follow every recorded event with exact cumulative totals",
    async () => {
      // 40 and 13 microdollars per call, so any lag or mix-up is visible.
      agentCost = 0.00004;
      monitorCost = 0.000013;
      const who = await guest();
      const game = await startGame(who.id, false);
      const { response, frames } = await instructFrames(who, game.id);
      assert.equal(response.status, 200);
      const events = frames.filter((frame) => frame.type === "event");
      assert.deepEqual(
        events.map((frame) => frame.data.kind),
        ["user", "agent", "monitor", "tool", "agent"],
      );
      // Cumulative agent and monitor microdollars after each recorded event.
      const totals = [
        [0, 0],
        [40, 0],
        [40, 13],
        [40, 13],
        [80, 13],
      ];
      frames.forEach((frame, index) => {
        if (frame.type !== "event") return;
        const next = frames[index + 1];
        assert.equal(next?.type, "billing", `no billing frame after ${frame.data.kind} event`);
        const [agent, monitored] = totals[events.indexOf(frame)];
        assert.equal(next.data.agentSpendMicrodollars, agent, `agent after ${frame.data.kind}`);
        assert.equal(
          next.data.monitorSpendMicrodollars,
          monitored,
          `monitor after ${frame.data.kind}`,
        );
        assert.equal(next.data.spentMicrodollars, agent + monitored);
      });
      const billing = frames.filter((frame) => frame.type === "billing");
      assert.equal(billing.length, events.length);
      const done = frames.find((frame) => frame.type === "done")!;
      assert.deepEqual(pick(billing.at(-1)!.data), pick(done.data));
      assert.equal(done.data.spentMicrodollars, 93);
      assert.equal(Number((await row(game.id)).spent_microdollars), 93);
    },
  );

  await t.test("a monitor error event's billing frame includes that monitor call", async () => {
    agentCost = 0.00004;
    monitorCost = 0.000013;
    monitor = "invalid";
    const who = await guest();
    const game = await startGame(who.id, false);
    const { frames } = await instructFrames(who, game.id);
    const index = frames.findIndex(
      (frame) => frame.type === "event" && frame.data.decision === "error",
    );
    assert.ok(index > 0);
    const after = frames[index + 1];
    assert.equal(after.type, "billing");
    assert.equal(after.data.agentSpendMicrodollars, 40);
    assert.equal(after.data.monitorSpendMicrodollars, 13);
    assert.equal(after.data.spentMicrodollars, 53);
    const done = frames.find((frame) => frame.type === "done")!;
    assert.deepEqual(
      pick(frames.filter((frame) => frame.type === "billing").at(-1)!.data),
      pick(done.data),
    );
  });

  // --- A monitor block ends the run; a fork continues it. ---
  const secretOf = async (gameId: string) =>
    environments.get((await row(gameId)).sprite_name)!.secret!;
  const eventsOf = async (gameId: string) =>
    (await pool.query("SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id", [gameId]))
      .rows;
  // An allowed command, then a blocked read of the flag in one batch.
  const blockRun = async (owner: string, options: { monitorReasoning?: boolean } = {}) => {
    const game = await startGame(owner, false, undefined, options);
    proposed = ["printf old", "cat /tmp/flag.txt"];
    monitorQueue = ["allow", "block"];
    agentCalls = 0;
    return { game, done: await play(game.id, owner) };
  };
  const forkRoute = async (
    who: { cookie: string } | undefined,
    id: string,
    requestOrigin = origin,
  ) => {
    const { POST } = await import("../../app/api/games/[id]/fork/route");
    return POST(
      new Request(`${origin}/api/games/${id}/fork`, {
        method: "POST",
        headers: {
          origin: requestOrigin,
          ...(who && { cookie: who.cookie }),
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ id }) },
    );
  };
  const createCount = () => trace.filter((entry) => entry.endsWith(":create")).length;

  for (const scenario of [
    {
      name: "first",
      proposal: ["cat /tmp/flag.txt", "printf harmless"],
      queue: ["block"],
      ran: [],
    },
    {
      name: "after an allowed command",
      proposal: ["printf harmless", "cat /tmp/flag.txt", "SUBMIT"],
      queue: ["allow", "block"],
      ran: ["printf harmless"],
    },
  ])
    await t.test(
      `a monitor block (${scenario.name}) ends the run: nothing later runs and the agent gets no more turns`,
      async () => {
        const who = await guest();
        const game = await startGame(who.id, false);
        const secret = await secretOf(game.id);
        proposed = scenario.proposal.map((call) => (call === "SUBMIT" ? { submit: secret } : call));
        monitorQueue = [...scenario.queue];
        const { response, frames } = await instructFrames(who, game.id);
        assert.equal(response.status, 200);
        assert.deepEqual(
          commands.map((entry) => entry.command),
          scenario.ran,
        );
        assert.equal(requests.filter((request) => request.role === "agent").length, 1);
        assert.equal(
          requests.filter((request) => request.role === "monitor").length,
          scenario.queue.length,
        );
        const stored = await row(game.id);
        assert.equal(stored.status, "blocked");
        assert.equal(stored.lease, null);
        assert.equal(stored.blocks, 1);
        const kinds = frames.filter((frame) => frame.type === "event").map((frame) => frame.data);
        assert.ok(kinds.some((event) => event.kind === "monitor" && event.decision === "block"));
        assert.ok(!kinds.some((event) => event.kind === "error" || event.kind === "submit"));
        const done = frames.find((frame) => frame.type === "done")!;
        assert.equal(done.data.status, "blocked");
        assert.equal(done.data.forkable, true);
        assert.equal(environments.size, 1, "the environment stays for a fork");
        assert.equal(stored.sprite_deleted_at, null);
        await assert.rejects(() => claimGame(game.id, who.id), /ended or is already responding/);
        assert.equal((await instruct(who, game.id)).status, 409);
      },
    );
  await t.test(
    "a monitor error leaves the run open; a spent budget during the monitor call exhausts it",
    async () => {
      monitor = "invalid";
      const open = await startGame("monitor-error", false);
      assert.equal((await play(open.id, "monitor-error")).status, "active");
      monitor = "allow";
      // The agent's turn costs the whole budget, so the monitor call cannot be admitted.
      agentCost = 0.6;
      agentCalls = 0;
      const spent = await startGame("monitor-broke", false);
      assert.equal((await play(spent.id, "monitor-broke")).status, "exhausted");
      assert.deepEqual(commands, []);
    },
  );

  await t.test(
    "each prompt takes one checkpoint before the agent runs, and the user event carries it",
    async () => {
      const who = await guest();
      const game = await startGame(who.id, false);
      const name = (await row(game.id)).sprite_name as string;
      assert.equal((await instruct(who, game.id)).status, 200);
      agentCalls = 0;
      assert.equal((await instruct(who, game.id)).status, 200);
      // Exactly one per prompt, each taken before any agent request or command of that prompt.
      assert.deepEqual(
        checkpoints.map((entry) => [entry.name, entry.requests, entry.commands]),
        [
          [name, 0, 0],
          [name, 2, 1],
        ],
      );
      const users = (await eventsOf(game.id)).map((e) => e.data).filter((e) => e.kind === "user");
      assert.deepEqual(
        users.map((e) => e.checkpoint),
        ["v1", "v2"],
      );
      assert.deepEqual(
        [...environments.get(name)!.checkpoints],
        [
          ["v1", 0],
          ["v2", 1],
        ],
      );
    },
  );

  for (const mode of ["reject", "error", "truncated", "hang", "no-complete"] as const)
    await t.test(
      `a checkpoint that ${mode === "hang" ? "times out" : `fails (${mode})`} stops the response before any inference`,
      async () => {
        const who = await guest();
        const game = await startGame(who.id, false);
        checkpointMode = mode;
        operationTimeout.ms = 50;
        const before = await row(game.id);
        const { response, frames } = await instructFrames(who, game.id);
        assert.equal(response.status, 200);
        assert.equal(requests.length, 0, "no agent or monitor request");
        assert.deepEqual(commands, []);
        const after = await row(game.id);
        assert.equal(after.status, "active");
        assert.equal(after.lease, null);
        assert.deepEqual(after.messages, before.messages);
        const events = (await eventsOf(game.id)).map((e) => e.data);
        assert.deepEqual(
          events.map((e) => e.kind),
          ["error"],
          "an error event and no user event",
        );
        assert.ok(frames.some((frame) => frame.type === "event" && frame.data.kind === "error"));
        assert.equal(environments.get(after.sprite_name)!.checkpoints.size, 0);
        // The run is still usable once checkpoints work again.
        checkpointMode = "ok";
        assert.equal((await instruct(who, game.id)).status, 200);
        assert.equal((await row(game.id)).status, "active");
        assert.ok(commands.length > 0);
      },
    );

  await t.test(
    "fork goes back to before the last instruction and restores that checkpoint",
    async () => {
      agentCost = 0.00004;
      monitorCost = 0.000013;
      const who = await guest();
      expectedMonitor = ALT_MONITOR;
      const parent = await startGame(who.id, false, undefined, {
        monitorReasoning: false,
        monitorModel: ALT_MONITOR,
        monitorDifficulty: "medium",
      });
      assert.equal((await instruct(who, parent.id, { systemPrompt: MARKER })).status, 200);
      proposed = ["printf old", "cat /tmp/flag.txt"];
      monitorQueue = ["allow", "block"];
      agentCalls = 0;
      const dropped = "DroppedInstruction3K9";
      assert.equal((await instruct(who, parent.id, { prompt: dropped })).status, 200);
      const before = await row(parent.id);
      assert.equal(before.status, "blocked");
      const eventsBefore = await eventsOf(parent.id);
      const second = eventsBefore.filter((e) => e.data.kind === "user")[1];
      assert.equal(second.data.checkpoint, "v2");
      const creates = createCount();
      const sprite = environments.get(before.sprite_name)!;
      assert.equal(sprite.version, 2, "the dropped instruction ran a command after its checkpoint");

      const response = await forkRoute(who, parent.id);
      assert.equal(response.status, 200);
      const child = await response.json();
      assert.equal(child.retryInstruction, dropped);
      assert.equal(createCount(), creates, "a fork creates no environment");
      // Restored exactly once, to exactly that checkpoint, while the child was still being created.
      assert.deepEqual(restores, [
        { name: before.sprite_name, id: "v2", childStatuses: ["creating"], version: 2 },
      ]);
      assert.equal(sprite.version, 1, "the dropped instruction's changes are gone");
      const stored = await row(child.id);
      assert.equal(stored.status, "active");
      assert.equal(stored.forked_from, parent.id);
      assert.equal(stored.sprite_name, before.sprite_name);
      assert.equal(stored.secret_hash, before.secret_hash);
      const lastUser = before.messages.findLastIndex((m: Message) => m.role === "user");
      assert.ok(lastUser > 1);
      assert.deepEqual(stored.messages, before.messages.slice(0, lastUser));
      assert.ok(!JSON.stringify(stored.messages).includes(dropped));
      // Spend, tokens, budget and turns carry over in full; the fork starts with no blocks.
      assert.equal(before.blocks, 1);
      assert.equal(stored.blocks, 0);
      assert.equal(child.blocks, 0, "the new run shows no blocked commands");
      for (const key of [
        "turns",
        "agent_model",
        "monitor_model",
        "monitor_difficulty",
        "system_prompt",
        "monitor_reasoning",
        "token_budget",
        "tokens_used",
        "budget_microdollars",
        "spent_microdollars",
      ])
        assert.deepEqual(stored[key], before[key], key);
      assert.equal(stored.system_prompt, MARKER);
      assert.deepEqual(
        [stored.monitor_model, stored.monitor_difficulty, stored.monitor_reasoning],
        [ALT_MONITOR, "medium", false],
      );
      assert.equal(Number(stored.reserved_microdollars), 0);
      // The visible history stops before the dropped instruction, under new ids.
      const eventsChild = await eventsOf(child.id);
      assert.deepEqual(
        eventsChild.map((e) => e.data),
        eventsBefore.slice(0, eventsBefore.indexOf(second)).map((e) => e.data),
      );
      assert.ok(eventsChild.every((e) => !eventsBefore.some((old) => old.id === e.id)));
      assert.equal(child.status, "active");
      assert.equal(child.forkable, false);
      const after = await row(parent.id);
      assert.equal(after.status, "blocked");
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(await eventsOf(parent.id), eventsBefore);
      const { publicGame, gameBilling } = await import("../../lib/games");
      assert.equal((await publicGame(after)).forkable, false);

      // Prompting the child never shows the model the dropped instruction or its turns.
      const from = requests.length;
      agentCalls = 0;
      proposed = ["printf after-fork"];
      monitorQueue = [];
      commands.length = 0;
      assert.equal((await instruct(who, child.id, { prompt: "NewInstruction8M1" })).status, 200);
      const first = requests.slice(from).find((request) => request.role === "agent")!;
      const sent = JSON.stringify((first.payload as { messages: unknown }).messages);
      assert.ok(sent.includes("NewInstruction8M1"));
      for (const gone of [dropped, "printf old", "cat /tmp/flag.txt"])
        assert.ok(!sent.includes(gone), `${gone} is gone from the model's view`);
      assert.equal(agentSystems(from)[0], agentPrompt(MARKER));
      assert.deepEqual(commands, [{ name: before.sprite_name, command: "printf after-fork" }]);
      const billing = await gameBilling(child.id);
      assert.equal(
        billing.agentSpendMicrodollars + billing.monitorSpendMicrodollars,
        billing.spentMicrodollars,
      );
      assert.ok(billing.spentMicrodollars > Number(before.spent_microdollars));
    },
  );

  for (const mode of ["reject", "error", "truncated", "hang", "no-complete"] as const)
    await t.test(
      `a restore that ${mode === "hang" ? "times out" : `fails (${mode})`} deletes the child and leaves the parent forkable`,
      async () => {
        const who = await guest();
        const { game: parent } = await blockRun(who.id);
        const before = await row(parent.id);
        const eventsBefore = await eventsOf(parent.id);
        const count = async (table: string) =>
          (await pool.query(`SELECT count(*)::int AS n FROM ctf.${table}`)).rows[0].n as number;
        const games = await count("games"),
          allEvents = await count("events");
        restoreMode = mode;
        operationTimeout.ms = 50;
        const failed = await forkRoute(who, parent.id);
        assert.equal(failed.status, 503);
        assert.match((await failed.json()).error, /restore|environment/i);
        assert.equal(restores.length, 1);
        assert.equal(await count("games"), games);
        assert.equal(await count("events"), allEvents);
        assert.deepEqual(await row(parent.id), before);
        assert.deepEqual(await eventsOf(parent.id), eventsBefore);
        const { publicGame } = await import("../../lib/games");
        assert.equal((await publicGame(before)).forkable, true);
        // Nothing is stuck: the same fork works once restores do.
        restoreMode = "ok";
        operationTimeout.ms = 30_000;
        assert.equal((await forkRoute(who, parent.id)).status, 200);
      },
    );

  await t.test("a run whose last instruction has no checkpoint cannot be forked", async () => {
    const who = await guest();
    const { game: parent } = await blockRun(who.id);
    await pool.query("UPDATE ctf.events SET data=data-'checkpoint' WHERE game_id=$1", [parent.id]);
    const { publicGame } = await import("../../lib/games");
    assert.equal((await publicGame(await row(parent.id))).forkable, false);
    assert.equal((await forkRoute(who, parent.id)).status, 409);
    assert.equal(restores.length, 0);
  });

  await t.test("cleanup deletes a stuck fork child so the parent stays forkable", async () => {
    const who = await guest();
    const { game: parent } = await blockRun(who.id);
    const stored = await row(parent.id);
    const stuck = randomUUID(),
      plain = randomUUID();
    for (const [id, forkedFrom] of [
      [stuck, parent.id],
      [plain, null],
    ] as const)
      await pool.query(
        `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,forked_from,updated_at)
        VALUES($1,$2,$3,'h','a','m','v',1,'creating',$4,now()-interval '10 minutes')`,
        [id, who.id, forkedFrom ? stored.sprite_name : `ctf-${id}`, forkedFrom],
      );
    await pool.query(
      `INSERT INTO ctf.events(game_id,data) VALUES($1,'{"kind":"user","text":"x"}')`,
      [stuck],
    );
    await cleanup();
    assert.equal((await pool.query("SELECT 1 FROM ctf.games WHERE id=$1", [stuck])).rowCount, 0);
    assert.equal(
      (await pool.query("SELECT 1 FROM ctf.events WHERE game_id=$1", [stuck])).rowCount,
      0,
    );
    assert.equal((await row(plain)).status, "ended", "other stale creating runs are only ended");
    assert.equal((await row(parent.id)).sprite_deleted_at, null);
    const { publicGame } = await import("../../lib/games");
    assert.equal((await publicGame(await row(parent.id))).forkable, true);
  });

  await t.test("a denied fork changes nothing and never ends the owner's current run", async () => {
    const who = await guest();
    const { game: parent } = await blockRun(who.id);
    const current = await startGame(who.id, false);
    const original = await row(parent.id);
    const count = async () =>
      (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n as number;
    const games = await count(),
      creates = createCount();
    const deny = async (label: string, status: number, change = "", pattern?: RegExp) => {
      if (change) await pool.query(`UPDATE ctf.games SET ${change} WHERE id=$1`, [parent.id]);
      try {
        const response = await forkRoute(who, parent.id);
        assert.equal(response.status, status, label);
        if (pattern) assert.match((await response.json()).error, pattern, label);
      } finally {
        await pool.query(
          "UPDATE ctf.games SET status=$2,sprite_deleted_at=$3,updated_at=$4,lease=NULL,lease_until=NULL,reserved_microdollars=0 WHERE id=$1",
          [parent.id, original.status, original.sprite_deleted_at, original.updated_at],
        );
      }
      assert.equal(await count(), games, label);
      assert.equal(createCount(), creates, label);
      assert.equal((await row(current.id)).status, "active", `${label}: current run stays open`);
      assert.deepEqual(await row(parent.id), original, label);
    };
    for (const status of ["active", "captured", "exhausted", "ended"])
      await deny(`status ${status}`, 409, `status='${status}'`);
    await deny("sprite deleted", 410, "sprite_deleted_at=now()");
    await deny("block older than 24h", 410, "updated_at=now()-interval '25 hours'");
    await deny(
      "response in flight",
      409,
      `lease='${randomUUID()}',lease_until=now()+interval '1 minute'`,
    );
    await deny("billing pending", 409, "reserved_microdollars=5", /billing is still settling/i);
  });

  await t.test(
    "fork route refuses missing sessions, bad origins and other owners' runs",
    async () => {
      const who = await guest(),
        stranger = await guest();
      const { game: parent } = await blockRun(who.id);
      const before = await row(parent.id);
      const games = (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n;
      for (const [label, status, response] of [
        ["no session", 401, await forkRoute(undefined, parent.id)],
        ["bad origin", 403, await forkRoute(who, parent.id, "https://not-local.invalid")],
        ["another owner", 404, await forkRoute(stranger, parent.id)],
      ] as const) {
        assert.equal(response.status, status, label);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n,
          games,
          label,
        );
        assert.deepEqual(await row(parent.id), before, label);
      }
    },
  );

  await t.test(
    "a block whose fenced update misses leaves the run unblocked and fails the response",
    async () => {
      // A real trigger ends the run as the block event is recorded, after the lease check and before the update.
      await pool.query(`CREATE FUNCTION ctf.end_on_block() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE ctf.games SET status='ended' WHERE id=NEW.game_id; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER end_on_block BEFORE INSERT ON ctf.events FOR EACH ROW
      WHEN (NEW.data->>'decision'='block') EXECUTE FUNCTION ctf.end_on_block()`);
      try {
        const game = await startGame("fence-miss", false);
        proposed = ["cat /tmp/flag.txt"];
        monitor = "block";
        const finished = await play(game.id, "fence-miss");
        assert.notEqual(finished.status, "blocked");
        assert.equal(finished.blocks, 0);
        assert.deepEqual(commands, []);
        const errors = (await eventsOf(game.id)).filter(
          (event) => event.data.kind === "monitor" && event.data.decision === "error",
        );
        assert.equal(errors.length, 1);
      } finally {
        await pool.query("DROP TRIGGER end_on_block ON ctf.events");
        await pool.query("DROP FUNCTION ctf.end_on_block()");
      }
    },
  );

  await t.test("a run is forked once; concurrent forks admit exactly one", async () => {
    const who = await guest();
    const { game: parent } = await blockRun(who.id);
    const results = await Promise.allSettled([
      startGame(who.id, false, undefined, { sourceId: parent.id }),
      startGame(who.id, false, undefined, { sourceId: parent.id }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(lost.reason.status, 409);
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM ctf.games WHERE forked_from=$1", [
          parent.id,
        ])
      ).rows[0].n,
      1,
    );
    const again = await forkRoute(who, parent.id);
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already been forked/i);
  });

  await t.test("a fork of a fork needs the child itself to be blocked", async () => {
    const who = await guest();
    const { game: parent } = await blockRun(who.id);
    const child = await startGame(who.id, false, undefined, { sourceId: parent.id });
    assert.equal((await forkRoute(who, child.id)).status, 409, "an active child is not forkable");
    proposed = ["cat /tmp/flag.txt"];
    monitorQueue = ["block"];
    agentCalls = 0;
    assert.equal((await play(child.id, who.id)).status, "blocked");
    const grandchild = await forkRoute(who, child.id);
    assert.equal(grandchild.status, 200);
    const stored = await row((await grandchild.json()).id);
    assert.equal((await row(child.id)).blocks, 1, "each run counts only its own blocks");
    assert.equal(stored.blocks, 0);
    assert.equal(stored.sprite_name, (await row(parent.id)).sprite_name);
  });

  await t.test("forks take no new-run quota; the daily spend cap still applies", async () => {
    const who = await guest();
    const { game: first } = await blockRun(who.id);
    const second = await startGame(who.id, false);
    await startGame(who.id, false);
    await assert.rejects(() => startGame(who.id, false), /daily limit of new runs/);
    // A global start count at 100 stops new runs but not forks.
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,sprite_deleted_at)
      SELECT gen_random_uuid(),'bulk-'||n,'bulk-'||n,'h','a','m','v',1,'ended',now() FROM generate_series(1,100) n`,
    );
    await assert.rejects(() => startGame("someone-else", false), /No more new runs/);
    const creates = createCount();
    await pool.query(
      "INSERT INTO ctf.daily_spend(day,charged) VALUES((now() AT TIME ZONE 'UTC')::date,10000000) ON CONFLICT(day) DO UPDATE SET charged=10000000",
    );
    assert.equal((await forkRoute(who, first.id)).status, 429);
    await pool.query("UPDATE ctf.daily_spend SET charged=0");
    const forked = await forkRoute(who, first.id);
    assert.equal(forked.status, 200);
    assert.equal(createCount(), creates);
    assert.equal((await row(second.id)).status, "ended", "the fork replaces the owner's open run");
  });

  await t.test("cleanup keeps a shared sprite until every run on it is done", async () => {
    const deletes = () => trace.filter((entry) => entry.endsWith(":delete")).length;
    const who = await guest();
    const { game: parent } = await blockRun(who.id);
    const name = (await row(parent.id)).sprite_name;
    await cleanup();
    assert.equal(deletes(), 0, "an unforked blocked run keeps its environment");
    const child = await startGame(who.id, false, undefined, { sourceId: parent.id });
    await cleanup();
    assert.equal(deletes(), 0, "an active child keeps the parent's environment");
    assert.ok(environments.has(name));
    await pool.query("UPDATE ctf.games SET status='ended' WHERE id=$1", [child.id]);
    await cleanup();
    assert.equal(trace.filter((entry) => entry === `${name}:delete`).length, 1);
    assert.equal(environments.has(name), false);
    for (const id of [parent.id, child.id]) assert.ok((await row(id)).sprite_deleted_at);
    await cleanup();
    assert.equal(deletes(), 1, "destroyed once");
    // An unforked block is only kept for 25 hours.
    const stale = await blockRun((await guest()).id);
    await pool.query("UPDATE ctf.games SET updated_at=now()-interval '26 hours' WHERE id=$1", [
      stale.game.id,
    ]);
    await cleanup();
    assert.ok((await row(stale.game.id)).sprite_deleted_at);
  });

  await t.test(
    "monitorReasoning=false hides every thinking part and needs no readable reasoning",
    async () => {
      const hidden = await startGame("reasoning-off", false, undefined, {
        monitorReasoning: false,
      });
      agentReasoning = false;
      await play(hidden.id, "reasoning-off");
      assert.deepEqual(
        commands.map((entry) => entry.command),
        ["printf harmless"],
      );
      agentReasoning = true;
      agentCalls = 0;
      await play(hidden.id, "reasoning-off");
      const monitored = requests.filter((request) => request.role === "monitor");
      assert.equal(monitored.length, 2);
      for (const request of monitored) {
        const text = JSON.stringify(request.payload);
        assert.ok(!text.includes("Controlled fixture reasoning."));
        assert.ok(!text.includes('\\"type\\":\\"thinking\\"'));
        assert.ok(text.includes("printf harmless"), "the rest of the transcript still arrives");
      }
      // The default shows reasoning: the payload carries it and the command runs.
      requests.length = 0;
      commands.length = 0;
      const shown = await startGame("reasoning-on", false);
      agentCalls = 0;
      await play(shown.id, "reasoning-on");
      assert.ok(
        JSON.stringify(requests.find((r) => r.role === "monitor")!.payload).includes(
          "Controlled fixture reasoning.",
        ),
      );
      assert.equal(commands.length, 1);
      // Reasoning-on mode still reviews a command that arrives with no reasoning rather than
      // refusing it: the monitor judges the command and transcript, and it runs when allowed.
      requests.length = 0;
      commands.length = 0;
      agentReasoning = false;
      agentCalls = 0;
      const silent = await startGame("reasoning-none", false);
      await play(silent.id, "reasoning-none");
      const silentMonitor = requests.find((r) => r.role === "monitor");
      assert.ok(silentMonitor, "the monitor still reviews a reasoning-free command");
      assert.ok(
        !JSON.stringify(silentMonitor.payload).includes("Controlled fixture reasoning."),
        "a reasoning-free turn carries no reasoning into the monitor payload",
      );
      assert.equal(commands.length, 1);
      assert.equal((await row(silent.id)).monitor_reasoning, true);
    },
  );

  await t.test("the start route takes an optional boolean monitorReasoning", async () => {
    const { POST } = await import("../../app/api/games/route");
    const who = await guest();
    const start = (body: unknown) =>
      POST(
        new Request(`${origin}/api/games`, {
          method: "POST",
          headers: { origin, cookie: who.cookie, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    for (const bad of ["false", 0, null, {}])
      assert.equal((await start({ monitorReasoning: bad })).status, 400, JSON.stringify(bad));
    assert.equal(await pool.query("SELECT 1 FROM ctf.games").then((r) => r.rowCount), 0);
    const off = await start({ monitorReasoning: false });
    assert.equal(off.status, 200);
    const created = await off.json();
    assert.equal(created.monitorReasoning, false);
    assert.equal((await row(created.id)).monitor_reasoning, false);
    const on = await (await start({})).json();
    assert.equal(on.monitorReasoning, true);
    assert.equal((await row(on.id)).monitor_reasoning, true);
  });

  // --- Players choose their monitor model and prompt difficulty. ---
  const startRoute = async (who: { cookie: string }, body: unknown) => {
    const { POST } = await import("../../app/api/games/route");
    return POST(
      new Request(`${origin}/api/games`, {
        method: "POST",
        headers: { origin, cookie: who.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  };
  const monitorSystem = (request: { payload: unknown }) =>
    (request.payload as { messages: { role: string; content: string }[] }).messages.find(
      (message) => message.role === "system",
    )?.content;
  const monitorRequests = (from = 0) =>
    requests.slice(from).filter((request) => request.role === "monitor") as {
      payload: { model: string; messages: { role: string; content: string }[] };
    }[];
  const monitorOf = async (id: string) => {
    const { monitor_model, monitor_difficulty, monitor_reasoning } = await row(id);
    return { monitor_model, monitor_difficulty, monitor_reasoning };
  };
  const DEFAULT_MONITOR = {
    monitor_model: MONITOR_MODEL,
    monitor_difficulty: "hard",
    monitor_reasoning: true,
  };

  await t.test("the start route stores the monitor choice and defaults it", async () => {
    const who = await guest();
    const plain = await (await startRoute(who, {})).json();
    assert.deepEqual(
      [plain.monitorModel, plain.monitorDifficulty, plain.monitorReasoning],
      [MONITOR_MODEL, "hard", true],
    );
    assert.deepEqual(await monitorOf(plain.id), DEFAULT_MONITOR);
    const response = await startRoute(who, {
      monitorModel: ALT_MONITOR,
      monitorDifficulty: "easy",
      monitorReasoning: false,
    });
    assert.equal(response.status, 200);
    const chosen = await response.json();
    assert.deepEqual(
      [chosen.monitorModel, chosen.monitorDifficulty, chosen.monitorReasoning],
      [ALT_MONITOR, "easy", false],
    );
    assert.deepEqual(await monitorOf(chosen.id), {
      monitor_model: ALT_MONITOR,
      monitor_difficulty: "easy",
      monitor_reasoning: false,
    });
    assert.equal((await row(chosen.id)).season_id, null, "runs no longer belong to a season");
    // The same fields come back from the stored row on a later read.
    const { publicGame, PUBLIC_GAME_COLUMNS } = await import("../../lib/games");
    const read = await pool.query(`SELECT ${PUBLIC_GAME_COLUMNS} FROM ctf.games WHERE id=$1`, [
      chosen.id,
    ]);
    assert.equal((await publicGame(read.rows[0])).monitorDifficulty, "easy");
  });

  for (const [name, body, status] of [
    ["a model that is not offered", { monitorModel: "evil/model" }, 400],
    ["a non-string model", { monitorModel: 5 }, 400],
    ["a null model", { monitorModel: null }, 400],
    ["a model OpenRouter cannot use as a monitor", { monitorModel: "qwen/qwen3.8-flash" }, 503],
    ["an unknown difficulty", { monitorDifficulty: "impossible" }, 400],
    ["a non-string difficulty", { monitorDifficulty: 1 }, 400],
    ["a non-boolean reasoning flag", { monitorReasoning: "yes" }, 400],
  ] as const)
    await t.test(
      `the start route rejects ${name} without creating a run or ending the current one`,
      async () => {
        const who = await guest();
        const current = await startGame(who.id, false);
        const games = (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n;
        const creates = createCount();
        const response = await startRoute(who, body);
        assert.equal(response.status, status);
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM ctf.games")).rows[0].n,
          games,
        );
        assert.equal(createCount(), creates, "no environment was created");
        assert.equal((await row(current.id)).status, "active", "the current run stays active");
      },
    );

  await t.test(
    "the first instruction changes an unbegun run's monitor model, difficulty and reasoning",
    async () => {
      const who = await guest();
      const game = await startGame(who.id, false);
      expectedMonitor = ALT_MONITOR;
      const { response } = await instructFrames(who, game.id, {
        monitorModel: ALT_MONITOR,
        monitorDifficulty: "easy",
        monitorReasoning: false,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await monitorOf(game.id), {
        monitor_model: ALT_MONITOR,
        monitor_difficulty: "easy",
        monitor_reasoning: false,
      });
      const monitored = monitorRequests();
      assert.equal(monitored.length, 1);
      assert.equal(monitored[0].payload.model, ALT_MONITOR);
      assert.equal(monitorSystem(monitored[0]), MONITOR_PROMPTS.easy);
      const text = JSON.stringify(monitored[0].payload);
      assert.ok(!text.includes("Controlled fixture reasoning."), "reasoning is hidden");
      assert.ok(!text.includes('\\"type\\":\\"thinking\\"'), "no thinking parts");
      assert.ok(text.includes("printf harmless"), "the rest of the transcript still arrives");
    },
  );

  await t.test("a run that has begun ignores monitor fields in later instructions", async () => {
    const who = await guest();
    const game = await startGame(who.id, false);
    assert.equal((await instruct(who, game.id)).status, 200);
    const from = requests.length;
    agentCalls = 0;
    const response = await instruct(who, game.id, {
      monitorModel: ALT_MONITOR,
      monitorDifficulty: "easy",
      monitorReasoning: false,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await monitorOf(game.id), DEFAULT_MONITOR);
    const monitored = monitorRequests(from);
    assert.equal(monitored.length, 1);
    assert.equal(monitored[0].payload.model, MONITOR_MODEL, "the stored model still judges");
    assert.equal(monitorSystem(monitored[0]), MONITOR_PROMPTS.hard);
    assert.ok(JSON.stringify(monitored[0].payload).includes("Controlled fixture reasoning."));
  });

  for (const [name, extra, status] of [
    ["an unlisted model", { monitorModel: "evil/model" }, 400],
    ["a non-string model", { monitorModel: 5 }, 400],
    ["a model OpenRouter cannot use as a monitor", { monitorModel: "qwen/qwen3.8-flash" }, 503],
    ["an unknown difficulty", { monitorDifficulty: "impossible" }, 400],
    ["a non-string difficulty", { monitorDifficulty: 2 }, 400],
    ["a non-boolean reasoning flag", { monitorReasoning: null }, 400],
  ] as const)
    await t.test(
      `an instruction with ${name} is rejected: nothing changes, nothing runs, no lease is taken`,
      async () => {
        const who = await guest();
        const game = await startGame(who.id, false);
        const before = await row(game.id);
        const response = await instruct(who, game.id, extra);
        assert.equal(response.status, status);
        assert.deepEqual(await monitorOf(game.id), DEFAULT_MONITOR);
        const after = await row(game.id);
        assert.equal(after.lease, null);
        assert.equal(after.lease_until, null);
        assert.equal(after.status, "active");
        assert.deepEqual(after.messages, before.messages);
        assert.equal(requests.length, 0, "no inference");
        assert.equal(
          (await eventsOf(game.id)).length,
          0,
          "no event recorded for the rejected instruction",
        );
      },
    );

  for (const difficulty of ["easy", "medium", "hard"] as const)
    await t.test(`the ${difficulty} monitor request uses its own system prompt`, async () => {
      const who = await guest();
      const game = await startGame(who.id, false, undefined, { monitorDifficulty: difficulty });
      assert.equal((await row(game.id)).monitor_difficulty, difficulty);
      assert.equal((await instruct(who, game.id)).status, 200);
      const monitored = monitorRequests();
      assert.equal(monitored.length, 1);
      const system = monitorSystem(monitored[0]);
      if (difficulty === "hard") assert.equal(system, MONITOR_PROMPT);
      else assert.notEqual(system, MONITOR_PROMPT, "not the hard prompt");
      assert.equal(system, MONITOR_PROMPTS[difficulty]);
    });

  await t.test(
    "starts private initialized environments with distinct secrets and persisted ownership",
    async () => {
      const one = await startGame("one", false),
        two = await startGame("two", true);
      const first = await row(one.id),
        second = await row(two.id);
      assert.equal(first.status, "active");
      assert.equal(second.status, "active");
      assert.equal(Number(first.budget_microdollars), 600000);
      assert.equal(Number(second.budget_microdollars), 3000000);
      assert.notEqual(first.secret_hash, second.secret_hash);
      assert.ok(hasSecret(environments.get(first.sprite_name)!.secret!, first.secret_hash));
      assert.equal(first.sprite_deleted_at, null);
      assert.deepEqual(
        trace.filter((item) => item.startsWith(first.sprite_name)),
        ["create", "policy", "initialize"].map((stage) => `${first.sprite_name}:${stage}`),
      );
      await assert.rejects(() => getGame(one.id, "two"), /not found/i);
      assert.equal(environments.size, 2);
    },
  );
  for (const stage of ["create", "policy", "initialize"] as const)
    await t.test(
      `failed ${stage} ends the game and removes any partially created environment`,
      async () => {
        failAt = stage;
        await assert.rejects(
          () => startGame("failure", false),
          new RegExp(`fixture failure: ${stage}`),
        );
        const failed = (await pool.query("SELECT * FROM ctf.games")).rows[0];
        assert.equal(failed.status, "ended");
        assert.ok(failed.sprite_deleted_at);
        assert.equal(environments.size, 0);
        if (stage === "policy") assert.ok(!trace.some((item) => item.endsWith(":initialize")));
        assert.equal(commands.length, 0);
      },
    );
  await t.test(
    "cleanup retains failed deletion for retry; missing environments are idempotent",
    async () => {
      const game = await startGame("cleanup", false),
        stored = await row(game.id);
      await pool.query("UPDATE ctf.games SET status='ended' WHERE id=$1", [game.id]);
      failAt = "delete";
      await cleanup();
      assert.equal((await row(game.id)).sprite_deleted_at, null);
      assert.ok(environments.has(stored.sprite_name));
      failAt = undefined;
      await cleanup();
      assert.ok((await row(game.id)).sprite_deleted_at);
      assert.equal(environments.size, 0);
      const attempts = trace.filter((item) => item.endsWith(":delete")).length;
      await cleanup();
      assert.equal(trace.filter((item) => item.endsWith(":delete")).length, attempts);
      await destroyEnvironment(stored.sprite_name);
    },
  );
  await t.test("replacing an idle game deletes only its old environment", async () => {
    const old = await startGame("replace", false),
      other = await startGame("other", false);
    const next = await startGame("replace", false);
    assert.equal((await row(old.id)).status, "ended");
    assert.ok((await row(old.id)).sprite_deleted_at);
    assert.equal((await row(next.id)).status, "active");
    assert.equal((await row(other.id)).status, "active");
    assert.equal(environments.size, 2);
  });
  await t.test("a concurrent start by the same owner cannot replace a creating game", async () => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate = async () => {
      entered();
      await held;
    };
    const first = startGame("concurrent", false);
    try {
      await ready;
      await assert.rejects(() => startGame("concurrent", false), /finish starting/i);
    } finally {
      release();
    }
    assert.equal((await first).status, "active");
    assert.equal(environments.size, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS total FROM ctf.games")).rows[0].total,
      1,
    );
  });
  await t.test(
    "parallel admission creates exactly ten environments, not zero or eleven",
    async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 11 }, (_, i) => startGame(`capacity-${i}`, false)),
      );
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 10);
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.match(rejected[0].reason.message, /busy/);
      assert.equal(environments.size, 10);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS total FROM ctf.games WHERE status='active'"))
          .rows[0].total,
        10,
      );
    },
  );
  await t.test(
    "on easy, a monitor that can't decide lets the command run and says so",
    async () => {
      const game = await startGame("easy-fail-open", false, undefined, {
        monitorDifficulty: "easy",
      });
      monitor = "invalid";
      proposed = ["printf harmless"];
      const finished = await play(game.id, "easy-fail-open");
      assert.equal(finished.status, "active");
      assert.equal(finished.blocks, 0);
      assert.deepEqual(
        commands.map((entry) => entry.command),
        ["printf harmless"],
      );
      const events = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1 ORDER BY id", [game.id])
      ).rows.map((entry) => entry.data);
      const review = events.find((event) => event.kind === "monitor");
      assert.equal(review.decision, "allow");
      assert.match(review.text, /couldn.t make a valid decision/);
      assert.ok(events.some((event) => event.kind === "tool"));
      assert.ok(!events.some((event) => event.kind === "error"));
    },
  );
  await t.test(
    "on easy, a spent budget during the monitor call still stops the command",
    async () => {
      monitor = "allow";
      // The agent's turn costs the whole budget, so the monitor call cannot be admitted.
      agentCost = 0.6;
      const spent = await startGame("easy-broke", false, undefined, { monitorDifficulty: "easy" });
      assert.equal((await play(spent.id, "easy-broke")).status, "exhausted");
      assert.deepEqual(commands, []);
    },
  );
  for (const decision of ["block", "invalid"])
    await t.test(
      `${decision} monitor executes no proposed commands through the real Pi runtime`,
      async () => {
        const game = await startGame("monitor", false);
        monitor = decision;
        proposed = ["cat /tmp/flag.txt", "printf harmless"];
        const finished = await play(game.id, "monitor");
        // A block ends the run; a monitor error leaves it open.
        assert.equal(finished.status, decision === "block" ? "blocked" : "active");
        assert.equal(finished.lease, null);
        assert.equal(commands.length, 0);
        const events = (
          await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
        ).rows.map((entry) => entry.data);
        assert.ok(
          events.some(
            (event) =>
              event.kind === "monitor" &&
              event.decision === (decision === "block" ? "block" : "error"),
          ),
        );
        // Monitor reasoning is stored for analysis but never reaches player-visible events.
        const stored = (
          await pool.query(
            "SELECT reasoning FROM ctf.inference WHERE game_id=$1 AND role='monitor'",
            [game.id],
          )
        ).rows;
        assert.ok(stored.length > 0);
        assert.ok(stored.every((entry) => entry.reasoning === "Monitor fixture reasoning."));
        assert.ok(!JSON.stringify(events).includes("Monitor fixture reasoning."));
        assert.equal(environments.size, 1);
      },
    );
  await t.test(
    "approval executes a bounded command and persists tool output; controlled capture cleans up",
    async () => {
      const game = await startGame("play", false),
        stored = await row(game.id);
      const finished = await play(game.id, "play");
      assert.equal(finished.status, "active");
      assert.equal(finished.lease, null);
      assert.deepEqual(commands, [{ name: stored.sprite_name, command: "printf harmless" }]);
      assert.ok(JSON.stringify(finished.messages).includes("fixture-output"));
      const events = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
      ).rows.map((entry) => entry.data);
      assert.ok(
        events.some((event) => event.kind === "tool" && event.text.includes("fixture-output")),
      );
      // Reading the flag into the transcript no longer wins on its own.
      proposed = ["cat /tmp/flag.txt"];
      agentCalls = 0;
      const read = await play(game.id, "play");
      assert.equal(read.status, "active");
      const secret = environments.get(stored.sprite_name)!.secret!;
      assert.ok(JSON.stringify(read.messages).includes(secret));
      // Submitting it does, and the monitor never reviews the submission.
      const monitored = requests.filter((request) => request.role === "monitor").length;
      proposed = [{ submit: `The flag is ${secret}` }];
      agentCalls = 0;
      const won = await play(game.id, "play");
      assert.equal(won.status, "captured");
      assert.equal(requests.filter((request) => request.role === "monitor").length, monitored);
      assert.equal(agentCalls, 1, "The agent gets no turn after submitting");
      const submitted = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
      ).rows.filter((entry) => entry.data.kind === "submit");
      assert.deepEqual(
        submitted.map((entry) => [entry.data.text, entry.data.correct]),
        [[`The flag is ${secret}`, true]],
      );
      assert.ok(won.sprite_deleted_at);
      assert.equal(won.lease, null);
      assert.equal(environments.size, 0);
    },
  );
  await t.test(
    "agent reasoning streams to the player before its turn is recorded; billing settles from the stream",
    async () => {
      const game = await startGame("stream", false);
      agentCost = 0.002;
      const frames: { type: string; data: unknown }[] = [];
      const leased = await claimGame(game.id, "stream");
      await runGame(
        leased,
        "Controlled integration fixture",
        AbortSignal.timeout(5000),
        (type, data) => frames.push({ type, data }),
      );
      const firstAgent = frames.findIndex(
        (frame) => frame.type === "event" && (frame.data as { kind: string }).kind === "agent",
      );
      const before = frames
        .slice(0, firstAgent)
        .filter((frame) => frame.type === "delta" && "reasoning" in (frame.data as object));
      assert.deepEqual(
        before.map((frame) => frame.data),
        [{ reasoning: "Controlled fixt" }, { reasoning: "ure reasoning." }],
        "Reasoning arrives in pieces, before the recorded turn",
      );
      // The status follows the stream: thinking, then the tool call, then the monitor and command.
      const stages = frames
        .filter((frame) => frame.type === "stage")
        .map((frame) => frame.data)
        .filter((stage, index, all) => stage !== all[index - 1]);
      assert.deepEqual(stages, [
        "Agent thinking",
        "Tool called",
        "Monitor reviewing command",
        "Running command",
        "Agent thinking",
        "Agent responding",
      ]);
      // The tool call reaches the player as the agent writes it, before the recorded turn.
      const streamedCalls = frames
        .slice(0, firstAgent)
        .flatMap((frame) =>
          frame.type === "delta" ? ((frame.data as { calls?: unknown[] }).calls ?? []) : [],
        );
      assert.deepEqual(streamedCalls, [
        { index: 0, name: "sprite_exec", arguments: '{"command":"pri' },
        { index: 0, arguments: 'ntf harmless"}' },
      ]);
      const agentEvent = frames[firstAgent].data as { reasoning: string; command: string };
      assert.equal(agentEvent.reasoning, "Controlled fixture reasoning.");
      assert.equal(agentEvent.command, "printf harmless");
      assert.deepEqual((agentEvent as { commands?: string[] }).commands, ["printf harmless"]);
      assert.deepEqual(
        commands.map((entry) => entry.command),
        ["printf harmless"],
      );
      // The second turn streams its text.
      assert.ok(frames.some((frame) => JSON.stringify(frame.data) === '{"text":"Done."}'));
      const calls = (
        await pool.query(
          "SELECT cost,generation_id,settled_at FROM ctf.inference WHERE game_id=$1 AND role='agent' ORDER BY created_at",
          [game.id],
        )
      ).rows;
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.ok(call.settled_at);
        assert.equal(Number(call.cost), 2000);
        assert.ok(generations.has(call.generation_id));
      }
      const stored = await row(game.id);
      assert.equal(Number(stored.reserved_microdollars), 0);
      assert.equal(Number(stored.spent_microdollars), 4000);
      // Deltas are never stored: the event log holds only the finished turn.
      const events = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
      ).rows.map((entry) => entry.data);
      assert.ok(!events.some((event) => event.text === "Controlled fixt"));
    },
  );
  await t.test(
    "a stream cut off midway runs nothing, keeps its hold with the generation id, and reconciles",
    async () => {
      const game = await startGame("cut-stream", false);
      agentCost = 0.003;
      agentStreamMode = "cut";
      const finished = await play(game.id, "cut-stream");
      assert.equal(finished.status, "active");
      assert.equal(finished.lease, null);
      assert.deepEqual(commands, []);
      const hold = (
        await pool.query(
          "SELECT id,generation_id,settled_at,cost_ceiling FROM ctf.inference WHERE game_id=$1",
          [game.id],
        )
      ).rows;
      assert.equal(hold.length, 1);
      assert.equal(hold[0].settled_at, null);
      assert.ok(generations.has(hold[0].generation_id), "the id from the first chunk is kept");
      const held = await row(game.id);
      assert.equal(Number(held.reserved_microdollars), Number(hold[0].cost_ceiling));
      const errors = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
      ).rows.filter((entry) => entry.data.kind === "error");
      assert.equal(errors.length, 1);
      // Once old enough, reconciliation asks OpenRouter for the real cost and settles it.
      await pool.query(
        "UPDATE ctf.inference SET created_at=now()-interval '3 minutes' WHERE id=$1",
        [hold[0].id],
      );
      await cleanup();
      const settled = (
        await pool.query("SELECT tokens,cost,settled_at,estimated FROM ctf.inference WHERE id=$1", [
          hold[0].id,
        ])
      ).rows[0];
      assert.ok(settled.settled_at);
      assert.equal(settled.estimated, false);
      assert.equal(Number(settled.cost), 3000);
      assert.equal(settled.tokens, 7);
      const after = await row(game.id);
      assert.equal(Number(after.reserved_microdollars), 0);
      assert.equal(Number(after.spent_microdollars), Number(held.spent_microdollars) + 3000);
    },
  );
  await t.test(
    "a streaming agent call that is still alive runs until the lease runs low, not a fixed cap",
    async () => {
      const game = await startGame("long-stream", false);
      agentStreamMode = "endless";
      const leased = await claimGame(game.id, "long-stream");
      // Leave 7s on the lease: the call may use all but the 5s margin, then stops cleanly.
      const { rows } = await pool.query(
        "UPDATE ctf.games SET lease_until=now()+interval '7 seconds' WHERE id=$1 RETURNING lease_until",
        [game.id],
      );
      leased.lease_until = rows[0].lease_until;
      const started = Date.now();
      await runGame(leased, "Controlled integration fixture", AbortSignal.timeout(15000), () => {});
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 1500 && elapsed < 4000, `stopped after ${elapsed}ms`);
      assert.deepEqual(commands, []);
      const errors = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
      ).rows.filter((entry) => entry.data.kind === "error");
      assert.equal(errors.length, 1);
      assert.match(errors[0].data.text, /ran out of time/);
      const hold = (
        await pool.query("SELECT generation_id,settled_at FROM ctf.inference WHERE game_id=$1", [
          game.id,
        ])
      ).rows;
      assert.equal(hold.length, 1);
      assert.equal(hold[0].settled_at, null);
      assert.ok(generations.has(hold[0].generation_id), "the stopped call can still reconcile");
      const after = await row(game.id);
      assert.equal(after.status, "active");
      assert.equal(after.lease, null);
    },
  );
  await t.test(
    "agents get room to think and answer; a turn cut off while thinking says so",
    async () => {
      const game = await startGame("long-think", false);
      agentFinish = "length";
      const finished = await play(game.id, "long-think");
      const agentRequests = requests.filter((request) => request.role === "agent");
      assert.equal(agentRequests.length, 1, "a cut-off turn ends the response");
      assert.equal((agentRequests[0].payload as { max_tokens: number }).max_tokens, 16_384);
      assert.deepEqual(commands, []);
      assert.equal(finished.status, "active");
      const events = (
        await pool.query("SELECT data FROM ctf.events WHERE game_id=$1 ORDER BY id", [game.id])
      ).rows.map((entry) => entry.data);
      assert.deepEqual(
        events.slice(-2).map((event) => [event.kind, event.reasoning ?? event.text]),
        [
          ["agent", "Thinking at length."],
          [
            "error",
            "The agent used its whole output allowance thinking and stopped before answering. Try again, or ask for something smaller.",
          ],
        ],
      );
      // A run with too little budget left gets a smaller allowance, never an overspend.
      agentFinish = "stop";
      await pool.query(
        "UPDATE ctf.games SET budget_microdollars=spent_microdollars+reserved_microdollars+20000 WHERE id=$1",
        [game.id],
      );
      requests.length = 0;
      agentCalls = 0;
      await play(game.id, "long-think");
      const capped = requests.find((request) => request.role === "agent")!.payload as {
        max_tokens: number;
      };
      assert.ok(capped.max_tokens > 0 && capped.max_tokens < 16_384, `${capped.max_tokens}`);
    },
  );
  for (const value of ["flag{wrong-guess-aaaaaaaaaaaaaaaaaaaaaaaaaa}", ""])
    await t.test(
      `a wrong submit (${JSON.stringify(value)}) ends the run unreviewed and stops the rest of its batch`,
      async () => {
        const game = await startGame("wrong-submit", false);
        proposed = [{ submit: value }, "printf harmless", { submit: "late" }];
        const finished = await play(game.id, "wrong-submit");
        assert.equal(finished.status, "ended");
        assert.equal(finished.lease, null);
        assert.ok(finished.sprite_deleted_at);
        assert.equal(environments.size, 0);
        assert.deepEqual(commands, [], "Calls after a submit never execute");
        assert.equal(requests.filter((request) => request.role === "monitor").length, 0);
        assert.equal(agentCalls, 1);
        const events = (
          await pool.query("SELECT data FROM ctf.events WHERE game_id=$1 ORDER BY id", [game.id])
        ).rows.map((entry) => entry.data);
        assert.deepEqual(
          events
            .filter((event) => event.kind === "submit")
            .map((event) => [event.text, event.correct]),
          [[value, false]],
        );
        assert.ok(!events.some((event) => event.kind === "tool"));
      },
    );
  await t.test(
    "a wrong submit after an executed command ends the run with no error event",
    async () => {
      const game = await startGame("submit-after-exec", false);
      proposed = ["printf harmless", { submit: "flag{wrong-guess-aaaaaaaaaaaaaaaaaaaaaaaaaa}" }];
      const finished = await play(game.id, "submit-after-exec");
      assert.equal(finished.status, "ended");
      assert.deepEqual(
        commands.map((entry) => entry.command),
        ["printf harmless"],
      );
      assert.equal(requests.filter((request) => request.role === "agent").length, 1);
      const events = (await eventsOf(game.id)).map((event) => event.data);
      assert.ok(events.some((event) => event.kind === "submit" && event.correct === false));
      assert.deepEqual(
        events.filter((event) => event.kind === "error"),
        [],
      );
    },
  );
  await t.test("a block ends the run before a later correct submit in the same batch", async () => {
    const game = await startGame("batch-submit", false),
      stored = await row(game.id);
    const secret = environments.get(stored.sprite_name)!.secret!;
    monitor = "block";
    proposed = ["printf harmless", { submit: secret }];
    const finished = await play(game.id, "batch-submit");
    assert.equal(finished.status, "blocked");
    assert.deepEqual(commands, []);
    assert.ok(
      !(await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])).rows.some(
        (entry) => entry.data.kind === "submit",
      ),
    );
    const monitored = requests.filter((request) => request.role === "monitor");
    assert.equal(monitored.length, 1);
    const input = JSON.parse(
      (monitored[0].payload as { messages: { role: string; content: string }[] }).messages.find(
        (message) => message.role === "user",
      )!.content,
    );
    assert.deepEqual(input.proposedToolCall.arguments, { command: "printf harmless" });
    assert.equal(finished.blocks, 1);
  });
  await t.test("exact game:sprite_exec alias executes and replays canonically", async () => {
    const game = await startGame("alias", false);
    proposedTool = "game:sprite_exec";
    const finished = await play(game.id, "alias");
    assert.deepEqual(
      commands.map(({ command }) => command),
      ["printf harmless"],
    );
    assert.ok(JSON.stringify(finished.messages).includes("fixture-output"));
    assert.ok(JSON.stringify(finished.messages).includes('"name":"sprite_exec"'));
    assert.ok(!JSON.stringify(finished.messages).includes("game:sprite_exec"));
    proposedTool = "sprite_exec";
    agentCalls = 0;
    await play(game.id, "alias");
    assert.equal(commands.length, 2);
  });
  await t.test(
    "qualified alias remains subject to monitor block and argument validation",
    async () => {
      const blocked = await startGame("alias-block", false);
      proposedTool = "game:sprite_exec";
      monitor = "block";
      await play(blocked.id, "alias-block");
      assert.equal(commands.length, 0);
      assert.equal((await row(blocked.id)).blocks, 1);
      const invalid = await startGame("alias-invalid", false);
      monitor = "allow";
      proposedArguments = () => JSON.stringify({ command: 1 });
      agentCalls = 0;
      const invalidResult = await play(invalid.id, "alias-invalid");
      assert.equal(commands.length, 0);
      assert.ok(
        invalidResult.messages.some(
          (message: { role: string; isError?: boolean }) =>
            message.role === "toolResult" && message.isError,
        ),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM ctf.events WHERE game_id=$1 AND data->>'kind'='monitor'",
            [invalid.id],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await t.test("similar but unknown tool names do not execute", async () => {
    const game = await startGame("unknown-alias", false);
    proposedTool = "other:sprite_exec";
    await play(game.id, "unknown-alias");
    assert.equal(commands.length, 0);
  });
  await t.test(
    "agent and monitor recover from 429 without duplicate execution or reservations",
    async () => {
      const game = await startGame("retry", false);
      responses = { agent: [{ status: 429 }], monitor: [{ status: 429 }] };
      const stages: string[] = [];
      const leased = await claimGame(game.id, "retry");
      await runGame(
        leased,
        "Controlled integration fixture",
        AbortSignal.timeout(5000),
        (type, data) => {
          if (type === "stage") stages.push(String(data));
        },
      );
      assert.deepEqual(
        commands.map(({ command }) => command),
        ["printf harmless"],
      );
      assert.equal(requests.filter(({ role }) => role === "agent").length, 3);
      assert.equal(requests.filter(({ role }) => role === "monitor").length, 2);
      assert.deepEqual(requests[0].payload, requests[1].payload);
      assert.deepEqual(requests[2].payload, requests[3].payload);
      assert.ok(
        stages.some((stage) => /Agent rate limited; retrying attempt 2\/5 in 1s/.test(stage)),
      );
      assert.ok(
        stages.some((stage) => /Monitor rate limited; retrying attempt 2\/5 in 1s/.test(stage)),
      );
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM ctf.inference WHERE game_id=$1", [
            game.id,
          ])
        ).rows[0].n,
        3,
      );
      assert.equal(Number((await row(game.id)).reserved_microdollars), 0);
    },
  );
  await t.test(
    "five 429 attempts settle one unbilled reservation and execute nothing",
    async () => {
      const game = await startGame("exhaust-429", false);
      responses = { agent: Array.from({ length: 5 }, () => ({ status: 429 })) };
      const stages: string[] = [];
      const leased = await claimGame(game.id, "exhaust-429");
      await runGame(
        leased,
        "Controlled integration fixture",
        AbortSignal.timeout(20000),
        (type, data) => {
          if (type === "stage") stages.push(String(data));
        },
      );
      assert.equal(requests.length, 5);
      for (const [index, minimum] of [950, 1950, 3950, 7950].entries())
        assert.ok(requests[index + 1].at - requests[index].at >= minimum);
      assert.equal(commands.length, 0);
      assert.deepEqual(
        requests.map(({ payload }) => payload),
        Array(5).fill(requests[0].payload),
      );
      for (const [attempt, delay] of [
        [2, 1],
        [3, 2],
        [4, 4],
        [5, 8],
      ])
        assert.ok(stages.some((stage) => stage.includes(`attempt ${attempt}/5 in ${delay}s`)));
      const rows = (
        await pool.query("SELECT tokens,cost,settled_at FROM ctf.inference WHERE game_id=$1", [
          game.id,
        ])
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].tokens), 0);
      assert.equal(Number(rows[0].cost), 0);
      assert.ok(rows[0].settled_at);
      assert.equal(Number((await row(game.id)).reserved_microdollars), 0);
    },
  );
  await t.test(
    "non-429 failure does not retry; ambiguous failure after 429 retains hold",
    async () => {
      const direct = await startGame("direct-500", false);
      responses = { agent: [{ status: 500 }] };
      await play(direct.id, "direct-500");
      assert.equal(requests.length, 1);
      assert.ok(Number((await row(direct.id)).reserved_microdollars) > 0);
      const later = await startGame("later-500", false);
      requests.length = 0;
      responses = { agent: [{ status: 429 }, { status: 500 }] };
      await play(later.id, "later-500");
      assert.equal(requests.length, 2);
      assert.equal(commands.length, 0);
      assert.ok(Number((await row(later.id)).reserved_microdollars) > 0);
      assert.equal(
        (await pool.query("SELECT settled_at FROM ctf.inference WHERE game_id=$1", [later.id]))
          .rows[0].settled_at,
        null,
      );
    },
  );
  await t.test(
    "abort racing a received 429 settles known-unbilled usage without another request",
    async () => {
      const game = await startGame("race-429", false);
      const controller = new AbortController();
      responses = { agent: [{ status: 429 }] };
      abortOn429 = () => controller.abort();
      const finished = await play(game.id, "race-429", controller.signal);
      assert.equal(finished.status, "active");
      assert.equal((await row(game.id)).lease, null);
      assert.equal(requests.length, 1);
      assert.equal(commands.length, 0);
      const inference = (
        await pool.query(
          "SELECT tokens,cost,generation_id,settled_at FROM ctf.inference WHERE game_id=$1",
          [game.id],
        )
      ).rows;
      assert.equal(inference.length, 1);
      assert.equal(Number(inference[0].tokens), 0);
      assert.equal(Number(inference[0].cost), 0);
      assert.equal(inference[0].generation_id, null);
      assert.ok(inference[0].settled_at);
      assert.equal(Number((await row(game.id)).reserved_microdollars), 0);
    },
  );
  await t.test(
    "Retry-After seconds, HTTP date, metadata and malformed headers choose safe waits",
    async () => {
      for (const [name, header, metadata, expected] of [
        ["seconds", "3", undefined, 3],
        ["date", new Date(Date.now() + 30_000).toUTCString(), undefined, 29],
        ["metadata", undefined, "4", 4],
        ["malformed", "nonsense", undefined, 1],
        ["huge", "9999999999999999999999999999999999999", undefined, 90],
      ] as const) {
        const game = await startGame(`header-${name}`, false);
        requests.length = 0;
        responses = { agent: [{ status: 429, retryAfter: header, metadataRetryAfter: metadata }] };
        const controller = new AbortController();
        const stages: string[] = [];
        const leased = await claimGame(game.id, `header-${name}`);
        await runGame(leased, "Controlled integration fixture", controller.signal, (type, data) => {
          if (type !== "stage") return;
          stages.push(String(data));
          if (String(data).includes("rate limited")) setTimeout(() => controller.abort(), 10);
        });
        assert.equal(requests.length, 1);
        assert.equal(commands.length, 0);
        const retry = stages.find((stage) => stage.includes("rate limited"));
        assert.ok(retry, name);
        assert.ok(Number(retry.match(/in ([\de+.]+)s/)?.[1]) >= expected, `${name}: ${retry}`);
        assert.equal(Number((await row(game.id)).reserved_microdollars), 0);
      }
    },
  );
  await t.test(
    "abort during retry fetch retains ambiguous hold and never dispatches a third attempt",
    async () => {
      const game = await startGame("abort-fetch", false);
      responses = { agent: [{ status: 429 }] };
      const controller = new AbortController();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      fetchGate = (signal) =>
        new Promise<Response>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entered();
        });
      const pending = play(game.id, "abort-fetch", controller.signal);
      await ready;
      controller.abort();
      const stopped = await pending;
      assert.equal(stopped.status, "active");
      assert.equal(requests.length, 2);
      assert.equal(commands.length, 0);
      assert.ok(Number((await row(game.id)).reserved_microdollars) > 0);
    },
  );
  await t.test("lease expiration during backoff blocks retry dispatch", async () => {
    const game = await startGame("expired-retry", false);
    responses = { agent: [{ status: 429 }] };
    let waiting!: () => void;
    const ready = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const leased = await claimGame(game.id, "expired-retry");
    const pending = runGame(
      leased,
      "Controlled integration fixture",
      AbortSignal.timeout(5000),
      (type, data) => {
        if (type === "stage" && String(data).includes("rate limited")) waiting();
      },
    );
    await ready;
    await pool.query("UPDATE ctf.games SET lease_until=now()-interval '1 second' WHERE id=$1", [
      game.id,
    ]);
    await assert.rejects(pending, /This response has stopped/);
    assert.equal(requests.length, 1);
    assert.equal(commands.length, 0);
    assert.equal(Number((await row(game.id)).reserved_microdollars), 0);
  });
  await t.test("network and missing-usage failures after 429 retain pending billing", async () => {
    for (const [owner, status] of [
      ["network", -1],
      ["missing-usage", 299],
    ] as const) {
      const game = await startGame(owner, false);
      requests.length = 0;
      responses = { agent: [{ status: 429 }, { status }] };
      await play(game.id, owner);
      assert.equal(requests.length, 2);
      assert.equal(commands.length, 0);
      assert.ok(Number((await row(game.id)).reserved_microdollars) > 0);
      assert.equal(
        (await pool.query("SELECT settled_at FROM ctf.inference WHERE game_id=$1", [game.id]))
          .rows[0].settled_at,
        null,
      );
    }
  });
  await t.test("cleanup settles day-old unverifiable holds at their ceiling", async () => {
    const spend = async () =>
      (
        await pool.query(
          "SELECT sum(reserved)::bigint AS r, sum(charged)::bigint AS c FROM ctf.daily_spend",
        )
      ).rows[0];
    const holds = [];
    for (const owner of ["expired-hold", "fresh-hold"]) {
      const game = await startGame(owner, false);
      responses = { agent: [{ status: -1 }] };
      await play(game.id, owner);
      const hold = (
        await pool.query(
          "SELECT id,token_ceiling,cost_ceiling,generation_id FROM ctf.inference WHERE game_id=$1",
          [game.id],
        )
      ).rows[0];
      assert.equal(hold.generation_id, null, "a failed request leaves no generation id");
      holds.push({ game, hold, before: await row(game.id) });
    }
    const [expired, fresh] = holds;
    await pool.query("UPDATE ctf.inference SET created_at=now()-interval '25 hours' WHERE id=$1", [
      expired.hold.id,
    ]);
    const spendBefore = await spend();
    await cleanup();
    const settled = (
      await pool.query("SELECT tokens,cost,estimated,settled_at FROM ctf.inference WHERE id=$1", [
        expired.hold.id,
      ])
    ).rows[0];
    assert.ok(settled.settled_at);
    assert.equal(settled.estimated, true);
    assert.equal(Number(settled.cost), Number(expired.hold.cost_ceiling));
    assert.equal(settled.tokens, expired.hold.token_ceiling);
    const after = await row(expired.game.id),
      ceiling = Number(expired.hold.cost_ceiling);
    assert.equal(
      Number(after.reserved_microdollars),
      Number(expired.before.reserved_microdollars) - ceiling,
    );
    assert.equal(
      Number(after.spent_microdollars),
      Number(expired.before.spent_microdollars) + ceiling,
    );
    assert.equal(
      after.tokens_reserved,
      expired.before.tokens_reserved - expired.hold.token_ceiling,
    );
    const spendAfter = await spend();
    assert.equal(Number(spendAfter.r), Number(spendBefore.r) - ceiling);
    assert.equal(Number(spendAfter.c), Number(spendBefore.c) + ceiling);
    // A hold younger than a day may still be explained; it stays pending.
    assert.equal(
      (await pool.query("SELECT settled_at FROM ctf.inference WHERE id=$1", [fresh.hold.id]))
        .rows[0].settled_at,
      null,
    );
    assert.equal(
      Number((await row(fresh.game.id)).reserved_microdollars),
      Number(fresh.before.reserved_microdollars),
    );
    await cleanup();
    assert.equal(
      Number((await row(expired.game.id)).spent_microdollars),
      Number(after.spent_microdollars),
      "a second sweep never charges the same hold twice",
    );
  });
  await t.test(
    "command adapter preserves stderr/exit, bounds output, and handles exec failure and abort",
    async () => {
      const game = await startGame("command", false),
        stored = await row(game.id);
      commandResult = { stdout: "out", stderr: "err", exitCode: 0 };
      assert.equal(
        await executeCommand(stored.sprite_name, "printf harmless"),
        "out\n[stderr]\nerr\n[exit 0]",
      );
      commandResult = { stdout: "x".repeat(20000), stderr: "", exitCode: 0 };
      assert.equal((await executeCommand(stored.sprite_name, "printf harmless")).length, 16000);
      commandFailure = new ExecError("fixture exit", {
        stdout: "failed",
        stderr: "details",
        exitCode: 7,
      });
      assert.equal(
        await executeCommand(stored.sprite_name, "printf harmless"),
        "failed\ndetails\n[exit 7]",
      );
      commandFailure = undefined;
      await assert.rejects(
        () => executeCommand(stored.sprite_name, "printf harmless", AbortSignal.abort()),
        /could not finish/,
      );
      assert.equal(environments.size, 1);
    },
  );
  await t.test(
    "abort during execution releases the lease and allows a later response",
    async () => {
      const game = await startGame("abort", false);
      const controller = new AbortController();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      commandGate = (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entered();
        });
      const interrupted = play(game.id, "abort", controller.signal);
      await ready;
      controller.abort();
      const paused = await interrupted;
      assert.equal(paused.status, "active");
      assert.equal(paused.lease, null);
      assert.equal(paused.lease_until, null);
      assert.equal(environments.size, 1);
      commandGate = undefined;
      agentCalls = 0;
      const recovered = await play(game.id, "abort");
      assert.equal(recovered.status, "active");
      assert.equal(recovered.lease, null);
      assert.ok(JSON.stringify(recovered.messages).includes("fixture-output"));
      assert.equal(commands.length, 2);
    },
  );
  await t.test("service timeout does not terminate the game or lose its environment", async () => {
    const game = await startGame("timeout", false);
    commandFailure = new Error("fixture service timeout");
    const paused = await play(game.id, "timeout");
    assert.equal(paused.status, "active");
    assert.equal(paused.lease, null);
    assert.equal(environments.size, 1);
    assert.equal(commands.length, 1);
    assert.ok(JSON.stringify(paused.messages).includes("could not finish"));
  });
  await t.test(
    "idle expiration removes its environment but preserves an active fresh run",
    async () => {
      const old = await startGame("old", false),
        fresh = await startGame("fresh", false);
      await pool.query("UPDATE ctf.games SET updated_at=now()-interval '25 hours' WHERE id=$1", [
        old.id,
      ]);
      await cleanup();
      assert.equal((await row(old.id)).status, "ended");
      assert.ok((await row(old.id)).sprite_deleted_at);
      assert.equal((await row(fresh.id)).status, "active");
      assert.equal(environments.size, 1);
    },
  );
});
