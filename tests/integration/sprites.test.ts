import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { Sprite, SpritesClient, ExecError, type ExecOptions } from "@fly/sprites";

// Only the runner's fresh loopback database is accepted; never read .env.local.
const connection = new URL(process.env.CTF_INTEGRATION_DATABASE_URL ?? "http://missing");
assert.equal(connection.hostname, "127.0.0.1", "Use npm run test:integration");
assert.match(connection.pathname, /^\/ctf_integration_[a-f0-9]{32}$/);
const pool = new Pool({ connectionString: connection.toString(), max: 5 });
// Use the existing pool seam with a real pg Pool, not mocked SQL or relaxed production TLS.
(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = pool;

await test("Sprite orchestration with real Postgres and Pi", { timeout: 60_000 }, async (t) => {
  t.after(async () => {
    await pool.end();
  });
  assert.equal(
    (await pool.query("SELECT to_regnamespace('ctf') AS schema")).rows[0].schema,
    null,
    "Refuse to change a database that already contains application data",
  );
  for (const file of ["../../db/schema.sql", "../../db/migrations/002-dollar-seasons.sql"])
    await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const { startGame, getGame, claimGame, cleanup } = await import("../../lib/games");
  const { executeCommand, destroyEnvironment } = await import("../../lib/sprites");
  const { runGame } = await import("../../lib/runner");
  const { AGENT_MODEL, MONITOR_MODEL, hasSecret } = await import("../../lib/policy");

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
  let proposed = ["printf harmless"];
  let agentCalls = 0;
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
          ["printf harmless", "cat /tmp/flag.txt"].includes(args[5]),
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
      let message;
      if (payload.response_format) {
        assert.equal(payload.model, MONITOR_MODEL);
        message = {
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
        assert.deepEqual(
          payload.tools.map((tool: { function: { name: string } }) => tool.function.name),
          ["sprite_exec"],
        );
        agentCalls++;
        message =
          agentCalls === 1
            ? {
                reasoning: "Controlled fixture reasoning.",
                tool_calls: proposed.map((command) => ({
                  id: randomUUID(),
                  type: "function",
                  function: { name: "sprite_exec", arguments: JSON.stringify({ command }) },
                })),
              }
            : { content: "Done." };
      }
      return Response.json({
        id: `test-${randomUUID()}`,
        choices: [{ message, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
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
    proposed = ["printf harmless"];
    agentCalls = 0;
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
      proposed = ["cat /tmp/flag.txt"];
      agentCalls = 0;
      const won = await play(game.id, "play");
      assert.equal(won.status, "captured");
      assert.ok(won.sprite_deleted_at);
      assert.equal(won.lease, null);
      assert.equal(environments.size, 0);
    },
  );
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
        /could not complete/,
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
    assert.ok(JSON.stringify(paused.messages).includes("could not complete"));
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
