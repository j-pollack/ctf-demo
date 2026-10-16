import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { Sprite, SpritesClient, ExecError, type ExecOptions } from "@fly/sprites";
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
  ])
    await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const { startGame, getGame, claimGame, cleanup } = await import("../../lib/games");
  const { executeCommand, destroyEnvironment } = await import("../../lib/sprites");
  const { runGame } = await import("../../lib/runner");
  const { AGENT_MODEL, AGENT_PROMPT, MODELS, MONITOR_MODEL, agentPrompt, hasSecret } =
    await import("../../lib/policy");

  const environments = new Map<string, { policy: boolean; secret?: string }>();
  const trace: string[] = [];
  const commands: { name: string; command: string }[] = [];
  const violations: string[] = [];
  let failAt: "create" | "policy" | "initialize" | "delete" | undefined;
  let gate: (() => Promise<void>) | undefined;
  let commandResult = { stdout: "fixture-output", stderr: "", exitCode: 0 };
  let commandFailure: Error | undefined;
  let commandGate: ((signal: AbortSignal) => Promise<void>) | undefined;
  let monitor = "allow";
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
  let lastAgentRequest = "";
  // "cut" ends an agent stream after its first chunk, with no usage; "endless" sends its first
  // chunk and then only keep-alives until the request is aborted.
  let agentStreamMode: "full" | "cut" | "endless" = "full";
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
      environments.set(name, { policy: false });
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
  t.mock.method(
    Sprite.prototype,
    "execFile",
    async function (this: Sprite, file: string, args: string[], options: ExecOptions) {
      return strict(async () => {
        const environment = environments.get(this.name);
        assert.ok(environment?.policy, "No initialization or execution before network policy");
        if (file === "bash") {
          assert.deepEqual(options, { timeout: 20_000, maxBuffer: 4096 });
          assert.equal(args[0], "-c");
          assert.equal(args.length, 2);
          const secret = args[1].match(
            /^mkdir -p \/workspace && printf '%s' '(flag\{[\w-]{32}\})' > \/tmp\/flag\.txt && chmod 644 \/tmp\/flag\.txt$/,
          )?.[1];
          assert.ok(secret, "Unexpected initialization script");
          trace.push(`${this.name}:initialize`);
          fixtureFailure("initialize");
          environment.secret = secret;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
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
          data: [...new Set([AGENT_MODEL, MONITOR_MODEL])].map((id) => ({
            id,
            context_length: 100000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
            supported_parameters: ["tools", "response_format", "reasoning"],
          })),
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
      if (payload.response_format) {
        assert.equal(payload.model, MONITOR_MODEL);
        // GLM rejects disabled reasoning, so the monitor requests low-effort hidden reasoning.
        assert.equal(MONITOR_MODEL, "z-ai/glm-5.3-flash");
        assert.deepEqual(payload.reasoning, { effort: "low", exclude: false });
        message = {
          reasoning: "Monitor fixture reasoning.",
          content:
            monitor === "invalid"
              ? "invalid JSON"
              : JSON.stringify({
                  allow: monitor === "allow",
                  reason: monitor === "block" ? "Protected read" : "",
                }),
        };
      } else {
        assert.equal(payload.model, AGENT_MODEL);
        assert.equal(payload.stream, true, "Agent calls stream");
        lastAgentRequest = JSON.stringify(payload.messages);
        assert.deepEqual(
          payload.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
          ["sprite_exec", "submit"],
        );
        agentCalls++;
        message =
          agentCalls === 1
            ? {
                reasoning: "Controlled fixture reasoning.",
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
        JSON.stringify({ id, choices: [{ delta: {}, finish_reason: "stop" }] }),
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
      "TRUNCATE ctf.events,ctf.inference,ctf.games,ctf.daily_spend,ctf.seasons RESTART IDENTITY CASCADE",
    );
    environments.clear();
    trace.length = 0;
    commands.length = 0;
    violations.length = 0;
    failAt = undefined;
    gate = undefined;
    commandFailure = undefined;
    commandGate = undefined;
    commandResult = { stdout: "fixture-output", stderr: "", exitCode: 0 };
    monitor = "allow";
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
    lastAgentRequest = "";
    agentStreamMode = "full";
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

  await t.test(
    "fork continuation repairs prior tool calls without replay and supports fork-of-fork",
    async () => {
      const parent = await startGame("fork-pi", false);
      proposed = ["printf old"];
      await play(parent.id, "fork-pi");
      const parentEvents = (
        await pool.query("SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id", [parent.id])
      ).rows;
      const firstAgent = parentEvents.find((event) => event.data.kind === "agent");
      assert.ok(firstAgent);
      const child = await startGame("fork-pi", false, undefined, {
        sourceId: parent.id,
        eventId: Number(firstAgent.id),
      });
      const childMessages: Message[] = (await row(child.id)).messages;
      const parentMessages: Message[] = (await row(parent.id)).messages;
      const boundary = parentMessages.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.stopReason !== "error" &&
          message.stopReason !== "aborted",
      );
      assert.equal(child.turns, 1);
      assert.ok(boundary >= 0);
      assert.deepEqual(childMessages, parentMessages.slice(0, boundary + 1));
      assert.equal(childMessages.at(-1)?.role, "assistant");
      assert.equal(
        childMessages.some((message) => message.role === "toolResult"),
        false,
      );
      const inheritedEvent = child.events.find((event) => event.kind === "agent");
      assert.ok(inheritedEvent);
      const grandchild = await startGame("fork-pi", false, undefined, {
        sourceId: child.id,
        eventId: inheritedEvent.id,
      });
      assert.equal(grandchild.turns, 1);
      assert.deepEqual((await row(grandchild.id)).messages, childMessages);
      const creates = trace.filter((entry) => entry.endsWith(":create")).length;
      await assert.rejects(
        () =>
          startGame("fork-pi", false, undefined, {
            sourceId: child.id,
            eventId: inheritedEvent.id,
          }),
        /daily limit of new runs/i,
      );
      assert.equal(trace.filter((entry) => entry.endsWith(":create")).length, creates);
      proposed = ["printf after-fork"];
      agentCalls = 0;
      commands.length = 0;
      const leased = await claimGame(grandchild.id, "fork-pi");
      await runGame(leased, "continue after fork", AbortSignal.timeout(5000), () => {});
      assert.deepEqual(
        commands.map((item) => item.command),
        ["printf after-fork"],
      );
      assert.ok(lastAgentRequest.includes("previous response was interrupted"));
      assert.ok(lastAgentRequest.includes("continue after fork"));
    },
  );

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

  await t.test(
    "actual authenticated fork route snapshots a validated transcript prefix",
    async () => {
      const who = await guest();
      const cookie = who.cookie;
      const source = await startGame(who.id, false);
      const baseMessages = [
        { role: "system", content: "", sections: { preamble: "system" }, timestamp: 1 },
        { role: "user", content: "first", timestamp: 2 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "first answer" },
            {
              type: "toolCall",
              id: "old-call",
              name: "sprite_exec",
              arguments: { command: "printf old" },
            },
          ],
          model: AGENT_MODEL,
          stopReason: "toolUse",
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "old-call",
          toolName: "sprite_exec",
          content: [{ type: "text", text: "old output" }],
          isError: false,
          timestamp: 4,
        },
        { role: "user", content: "second", timestamp: 5 },
        {
          role: "assistant",
          content: [{ type: "text", text: "later answer" }],
          model: AGENT_MODEL,
          stopReason: "stop",
          timestamp: 6,
        },
      ];
      await pool.query(
        "UPDATE ctf.games SET messages=$2,turns=2,blocks=1,spent_microdollars=123,agent_model=$3 WHERE id=$1",
        [source.id, JSON.stringify(baseMessages), MODELS.find((model) => model !== AGENT_MODEL)],
      );
      const seeded = [
        { kind: "user", text: "first" },
        { kind: "agent", text: "first answer", model: AGENT_MODEL, turn: 1 },
        { kind: "monitor", text: "blocked prior attempt", decision: "block", turn: 1 },
        { kind: "tool", text: "old output", turn: 1 },
        { kind: "user", text: "second" },
        { kind: "agent", text: "later answer", model: AGENT_MODEL, turn: 2 },
      ];
      for (const event of seeded)
        await pool.query("INSERT INTO ctf.events(game_id,data) VALUES($1,$2)", [
          source.id,
          JSON.stringify(event),
        ]);
      const sourceEvents = (
        await pool.query("SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id", [source.id])
      ).rows;
      const selectedId = Number(sourceEvents[1].id);
      const sourceSnapshot = await pool.query(
        "SELECT messages,turns,blocks,spent_microdollars,status FROM ctf.games WHERE id=$1",
        [source.id],
      );
      const { POST } = await import("../../app/api/games/[id]/fork/route");
      const request = (body: string, path = source.id, requestOrigin = origin) =>
        new Request(`${origin}/api/games/${path}/fork`, {
          method: "POST",
          headers: { origin: requestOrigin, cookie, "Content-Type": "application/json" },
          body,
        });
      const createCount = () => trace.filter((entry) => entry.endsWith(":create")).length;
      const initialCreateCount = createCount();
      const activeLease = randomUUID();
      await pool.query(
        "UPDATE ctf.games SET lease=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
        [source.id, activeLease],
      );
      const busyResponse = await POST(request(JSON.stringify({ eventId: selectedId })), {
        params: Promise.resolve({ id: source.id }),
      });
      assert.equal(busyResponse.status, 409);
      assert.equal(createCount(), initialCreateCount);
      await pool.query("UPDATE ctf.games SET lease=NULL,lease_until=NULL WHERE id=$1", [source.id]);
      const staleLease = randomUUID();
      await pool.query(
        "UPDATE ctf.games SET lease=$2,lease_until=now()-interval '1 second' WHERE id=$1",
        [source.id, staleLease],
      );
      for (const [body, path, requestOrigin, status] of [
        [`{"eventId":"${selectedId}"}`, source.id, origin, 400],
        [`{"eventId":${Number(sourceEvents[0].id)}}`, source.id, origin, 409],
        ["null", source.id, origin, 400],
        ["{}", source.id, origin, 400],
        [`{"eventId":${selectedId}}`, randomUUID(), origin, 404],
        [`{"eventId":${selectedId}}`, "not-a-uuid", origin, 404],
        [`{"eventId":${selectedId}}`, source.id, "https://not-local.invalid", 403],
        [`{"eventId":${selectedId}}`, source.id, origin, 200],
      ] as const) {
        const response = await POST(request(body, path, requestOrigin), {
          params: Promise.resolve({ id: path }),
        });
        assert.equal(response.status, status);
        if (status === 200) {
          const child = await response.json();
          assert.equal(child.agentModel, AGENT_MODEL);
          assert.equal(child.turns, 1);
          assert.equal(child.blocks, 0);
          assert.equal(child.events.length, 2);
          assert.notEqual(child.events[1].id, selectedId);
          const stored = await row(child.id);
          assert.deepEqual(stored.messages, baseMessages.slice(0, 3));
          assert.equal(Number(stored.budget_microdollars), 600000);
          assert.equal(Number(stored.spent_microdollars), 0);
          assert.equal(Number(stored.reserved_microdollars), 0);
          assert.equal(Number(stored.tokens_used), 0);
          assert.equal(stored.blocks, 0);
          assert.notEqual(stored.secret_hash, (await row(source.id)).secret_hash);
          assert.notEqual(stored.sprite_name, (await row(source.id)).sprite_name);
          assert.equal((await row(source.id)).lease, null);
        }
      }
      assert.equal(createCount(), initialCreateCount + 1);
      const { record } = await import("../../lib/games");
      await assert.rejects(
        () => record(source.id, { kind: "error", text: "stale runner" }, staleLease),
        /stopped/i,
      );
      const after = await pool.query(
        "SELECT messages,turns,blocks,spent_microdollars,status FROM ctf.games WHERE id=$1",
        [source.id],
      );
      assert.deepEqual(
        {
          messages: after.rows[0].messages,
          turns: after.rows[0].turns,
          blocks: after.rows[0].blocks,
          spent_microdollars: after.rows[0].spent_microdollars,
        },
        {
          messages: sourceSnapshot.rows[0].messages,
          turns: sourceSnapshot.rows[0].turns,
          blocks: sourceSnapshot.rows[0].blocks,
          spent_microdollars: sourceSnapshot.rows[0].spent_microdollars,
        },
      );
      assert.equal(after.rows[0].status, "ended");
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM ctf.events WHERE game_id=$1", [
            source.id,
          ])
        ).rows[0].n,
        seeded.length,
      );
      const unauthorized = await POST(
        new Request(`${origin}/api/games/${source.id}/fork`, {
          method: "POST",
          headers: { origin, "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: selectedId }),
        }),
        { params: Promise.resolve({ id: source.id }) },
      );
      assert.equal(unauthorized.status, 401);
      const foreignGuest = await guest();
      const foreignCookie = foreignGuest.cookie;
      const foreign = await POST(
        new Request(`${origin}/api/games/${source.id}/fork`, {
          method: "POST",
          headers: { origin, cookie: foreignCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: selectedId }),
        }),
        { params: Promise.resolve({ id: source.id }) },
      );
      assert.equal(foreign.status, 404);
      const other = await startGame("different-owner", false);
      const otherEvent = await pool.query(
        "INSERT INTO ctf.events(game_id,data) VALUES($1,$2) RETURNING id",
        [
          other.id,
          JSON.stringify({ kind: "agent", text: "other run", model: AGENT_MODEL, turn: 1 }),
        ],
      );
      const mismatch = await POST(
        request(JSON.stringify({ eventId: Number(otherEvent.rows[0].id) })),
        { params: Promise.resolve({ id: source.id }) },
      );
      assert.equal(mismatch.status, 409);
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[who.id, foreignGuest.id]]);
    },
  );

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

  await t.test("fork inherits the current system prompt and the child agent uses it", async () => {
    const who = await guest();
    const parent = await startGame(who.id, false);
    assert.equal((await instruct(who, parent.id, { systemPrompt: MARKER })).status, 200);
    const agentEvent = (
      await pool.query("SELECT id,data FROM ctf.events WHERE game_id=$1 ORDER BY id", [parent.id])
    ).rows.find((event) => event.data.kind === "agent");
    assert.ok(agentEvent);
    const child = await startGame(who.id, false, undefined, {
      sourceId: parent.id,
      eventId: Number(agentEvent.id),
    });
    assert.equal((await row(child.id)).system_prompt, MARKER);
    assert.equal(child.systemPrompt, MARKER);
    const from = requests.length;
    agentCalls = 0;
    assert.equal((await instruct(who, child.id)).status, 200);
    const systems = agentSystems(from);
    assert.ok(systems.length > 0);
    assert.deepEqual(systems, Array(systems.length).fill(agentPrompt(MARKER)));
  });

  await t.test(
    "failed fork provisioning ends the replaced source and cleans the partial child",
    async () => {
      const source = await startGame("fork-failure", false);
      await pool.query("UPDATE ctf.games SET messages=$2,turns=1 WHERE id=$1", [
        source.id,
        JSON.stringify([
          { role: "system", content: "", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "safe" }],
            model: AGENT_MODEL,
            stopReason: "stop",
            timestamp: 2,
          },
        ]),
      ]);
      const selected = await pool.query(
        "INSERT INTO ctf.events(game_id,data) VALUES($1,$2) RETURNING id",
        [source.id, JSON.stringify({ kind: "agent", text: "safe", model: AGENT_MODEL, turn: 1 })],
      );
      failAt = "create";
      await assert.rejects(
        () =>
          startGame("fork-failure", false, undefined, {
            sourceId: source.id,
            eventId: Number(selected.rows[0].id),
          }),
        /fixture failure: create/,
      );
      failAt = undefined;
      assert.equal((await row(source.id)).status, "ended");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM ctf.games WHERE owner_id='fork-failure' AND status IN ('creating','active')",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(environments.size, 0);
    },
  );

  await t.test(
    "claim/fork row-lock race admits exactly one winner in either lock order",
    async () => {
      const waitForLock = async (fragment: string) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE $1 LIMIT 1",
            [`%${fragment}%`],
          );
          if (result.rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`Timed out waiting for lock: ${fragment}`);
      };
      for (const winner of ["claim", "fork"] as const) {
        const owner = `race-${winner}`;
        const source = await startGame(owner, false);
        await pool.query("UPDATE ctf.games SET messages=$2,turns=1 WHERE id=$1", [
          source.id,
          JSON.stringify([
            { role: "system", content: "", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "safe" }],
              model: AGENT_MODEL,
              stopReason: "stop",
              timestamp: 2,
            },
          ]),
        ]);
        const event = await pool.query(
          "INSERT INTO ctf.events(game_id,data) VALUES($1,$2) RETURNING id",
          [source.id, JSON.stringify({ kind: "agent", text: "safe", model: AGENT_MODEL, turn: 1 })],
        );
        const lock = await pool.connect();
        await lock.query("BEGIN");
        await lock.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [source.id]);
        let first: Promise<unknown>, second: Promise<unknown>;
        if (winner === "claim") {
          first = claimGame(source.id, owner);
          await waitForLock("UPDATE ctf.games g SET lease");
          second = startGame(owner, false, undefined, {
            sourceId: source.id,
            eventId: Number(event.rows[0].id),
          });
          await waitForLock("SELECT * FROM ctf.games WHERE owner_id");
        } else {
          first = startGame(owner, false, undefined, {
            sourceId: source.id,
            eventId: Number(event.rows[0].id),
          });
          await waitForLock("SELECT * FROM ctf.games WHERE owner_id");
          second = claimGame(source.id, owner);
          await waitForLock("UPDATE ctf.games g SET lease");
        }
        await lock.query("COMMIT");
        lock.release();
        const [a, b] = await Promise.allSettled([first, second]);
        assert.equal([a, b].filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(a.status, "fulfilled");
        assert.equal(b.status, "rejected");
        assert.equal((await row(source.id)).status, winner === "claim" ? "active" : "ended");
      }
    },
  );

  await t.test(
    "an in-flight stale event write waits and is denied after fork revokes its lease",
    async () => {
      const source = await startGame("record-fork-race", false);
      const lease = randomUUID();
      await pool.query(
        "UPDATE ctf.games SET messages=$2,turns=1,lease=$3,lease_until=now()+interval '1 day' WHERE id=$1",
        [
          source.id,
          JSON.stringify([
            { role: "system", content: "", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "safe" }],
              model: AGENT_MODEL,
              stopReason: "stop",
              timestamp: 2,
            },
          ]),
          lease,
        ],
      );
      const event = await pool.query(
        "INSERT INTO ctf.events(game_id,data) VALUES($1,$2) RETURNING id",
        [source.id, JSON.stringify({ kind: "agent", text: "safe", model: AGENT_MODEL, turn: 1 })],
      );
      const lock = await pool.connect();
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM ctf.games WHERE id=$1 FOR UPDATE", [source.id]);
      const child = startGame("record-fork-race", false, undefined, {
        sourceId: source.id,
        eventId: Number(event.rows[0].id),
      });
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE '%SELECT * FROM ctf.games WHERE owner_id%' LIMIT 1",
        );
        if (result.rowCount) break;
        if (i === 199) throw new Error("Fork did not wait on source row lock");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const staleWrite = (await import("../../lib/games")).record(
        source.id,
        { kind: "tool", text: "late tool output" },
        lease,
      );
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE '%INSERT INTO ctf.events(game_id,data) SELECT%' LIMIT 1",
        );
        if (result.rowCount) break;
        if (i === 199) throw new Error("Stale event write did not wait on source row lock");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await lock.query("UPDATE ctf.games SET lease_until=now()-interval '1 second' WHERE id=$1", [
        source.id,
      ]);
      await lock.query("COMMIT");
      lock.release();
      const [forked, written] = await Promise.allSettled([child, staleWrite]);
      assert.equal(forked.status, "fulfilled");
      assert.equal(written.status, "rejected");
      assert.equal(
        (
          await pool.query("SELECT count(*)::int AS n FROM ctf.events WHERE game_id=$1", [
            source.id,
          ])
        ).rows[0].n,
        1,
      );
      assert.equal((await row(source.id)).status, "ended");
    },
  );

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
  for (const decision of ["block", "invalid"])
    await t.test(
      `${decision} monitor executes no proposed commands through the real Pi runtime`,
      async () => {
        const game = await startGame("monitor", false);
        monitor = decision;
        proposed = ["cat /tmp/flag.txt", "printf harmless"];
        const finished = await play(game.id, "monitor");
        assert.equal(finished.status, "active");
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
      const before = frames.slice(0, firstAgent).filter((frame) => frame.type === "delta");
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
      assert.ok(
        !frames.some((frame) => frame.type === "delta" && "tool" in (frame.data as object)),
        "tool names reach the player only as status",
      );
      const agentEvent = frames[firstAgent].data as { reasoning: string; command: string };
      assert.equal(agentEvent.reasoning, "Controlled fixture reasoning.");
      assert.equal(agentEvent.command, "printf harmless");
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
  await t.test("a command before a submit in the same batch is still monitored", async () => {
    const game = await startGame("batch-submit", false),
      stored = await row(game.id);
    const secret = environments.get(stored.sprite_name)!.secret!;
    monitor = "block";
    proposed = ["printf harmless", { submit: secret }];
    const finished = await play(game.id, "batch-submit");
    assert.equal(finished.status, "captured");
    assert.deepEqual(commands, []);
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
  await t.test("a correct submit after the season ends does not capture", async () => {
    const game = await startGame("late-submit", false),
      stored = await row(game.id);
    const secret = environments.get(stored.sprite_name)!.secret!;
    proposed = ["printf harmless", { submit: secret }];
    commandGate = async () => {
      await pool.query("UPDATE ctf.seasons SET ends_at=now()-interval '1 second' WHERE id=$1", [
        stored.season_id,
      ]);
    };
    const finished = await play(game.id, "late-submit");
    assert.equal(finished.status, "ended");
    const events = (
      await pool.query("SELECT data FROM ctf.events WHERE game_id=$1", [game.id])
    ).rows.map((entry) => entry.data);
    assert.ok(!events.some((event) => event.kind === "submit"));
    assert.ok(
      events.some((event) => event.kind === "error" && /season has ended/.test(event.text)),
    );
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
