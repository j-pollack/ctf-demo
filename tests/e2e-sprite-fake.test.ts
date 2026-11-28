import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SEED_BUGS, seedScoreCommand } from "../lib/seed";
import { COMMANDS } from "./e2e/agent-script";
import { createSpriteFake, patchSprites } from "./e2e/sprite-fake";

const HOST = "ctf.e2e.test";
const NAME = "ctf-00000000-0000-4000-8000-000000000001";
const FLAG = "flag{abcdefghijklmnopqrstuvwxyz012345}";
const CREATE = {
  config: { ramMB: 512, cpus: 1 },
  urlSettings: { auth: "sprite", privateAccess: "admins" },
};
const POLICY = {
  rules: [
    { domain: HOST, action: "allow" },
    { domain: "*", action: "deny" },
  ],
};
const SEED = `mkdir -p /workspace && tar -xzf - -C /workspace && printf '%s' '${FLAG}' > /tmp/flag.txt && chmod 644 /tmp/flag.txt`;
const initOptions = () => ({ input: Buffer.from([0x1f, 0x8b]), timeout: 20_000, maxBuffer: 4096 });
const execOptions = (over: Record<string, unknown> = {}) => ({
  cwd: "/workspace",
  timeout: 20_000,
  maxBuffer: 65536,
  signal: new AbortController().signal,
  maxRunAfterDisconnect: "1s",
  env: { TARGET: `https://${HOST}/v1/end/${"a".repeat(43)}` },
  ...over,
});
const wrap = (command: string) => ["-k", "2", "15", "bash", "-lc", command];

function setup(over: { appOrigin?: string; longBoundMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sprite-fake-"));
  return {
    dir,
    fake: createSpriteFake({ dir, host: HOST, appOrigin: "http://127.0.0.1:1", ...over }),
    done: () => rmSync(dir, { recursive: true }),
  };
}
async function ready(fake: ReturnType<typeof createSpriteFake>) {
  await fake.createSprite(NAME, CREATE);
  await fake.updateNetworkPolicy(NAME, POLICY);
  await fake.execFileHTTP(NAME, "bash", ["-c", SEED], initOptions());
}

test("a Sprite is created, initialised, commanded and deleted with its state on disk", async () => {
  const { dir, fake, done } = setup();
  try {
    await ready(fake);
    assert.deepEqual(readdirSync(dir), [NAME]);
    assert.deepEqual(await fake.getNetworkPolicy(NAME), POLICY);
    const listed = await fake.execFile(NAME, "timeout", wrap("ls /workspace"), execOptions());
    assert.deepEqual(listed, { stdout: "notes.txt\n", stderr: "", exitCode: 0 });
    const flag = await fake.execFile(NAME, "timeout", wrap("cat /tmp/flag.txt"), execOptions());
    assert.equal(flag.stdout, FLAG);
    assert.deepEqual(await fake.listSessions(NAME), []);
    await fake.deleteSprite(NAME);
    assert.equal(existsSync(join(dir, NAME)), false);
  } finally {
    done();
  }
});

test("a command outside the table, or an exec of the wrong form, throws", async () => {
  const { fake, done } = setup();
  try {
    await ready(fake);
    const bad: [string, string[], Record<string, unknown>, RegExp][] = [
      ["timeout", wrap("rm -rf /"), {}, /command/i],
      ["bash", wrap("ls /workspace"), {}, /timeout/],
      ["timeout", ["-k", "2", "15", "bash", "-c", "ls /workspace"], {}, /form/i],
      ["timeout", wrap("ls /workspace"), { cwd: "/tmp" }, /cwd/],
      ["timeout", wrap("ls /workspace"), { maxRunAfterDisconnect: "1m" }, /maxRunAfterDisconnect/],
      ["timeout", wrap("ls /workspace"), { signal: undefined }, /abort/i],
      ["timeout", wrap("ls /workspace"), { env: {} }, /TARGET/],
      [
        "timeout",
        wrap("ls /workspace"),
        { env: { TARGET: "https://other.test/v1/end/x" } },
        /TARGET/,
      ],
    ];
    for (const [file, args, over, pattern] of bad)
      await assert.rejects(() => fake.execFile(NAME, file, args, execOptions(over)), pattern);
  } finally {
    done();
  }
});

test("creation and initialisation are validated", async () => {
  const { fake, done } = setup();
  try {
    await assert.rejects(() => fake.createSprite("other", CREATE), /name/i);
    await assert.rejects(() => fake.createSprite(NAME, { config: {} }), /options/i);
    await assert.rejects(() => fake.updateNetworkPolicy(NAME, POLICY), /unknown/i);
    await fake.createSprite(NAME, CREATE);
    await assert.rejects(() => fake.createSprite(NAME, CREATE), /EEXIST|twice/i);
    await assert.rejects(
      () => fake.updateNetworkPolicy(NAME, { rules: [...POLICY.rules].reverse() }),
      /polic/i,
    );
    await assert.rejects(() => fake.getNetworkPolicy(NAME), /polic/i);
    await assert.rejects(
      () => fake.execFileHTTP(NAME, "bash", ["-c", SEED], initOptions()),
      /polic/i,
    );
    await fake.updateNetworkPolicy(NAME, POLICY);
    await assert.rejects(
      () => fake.execFile(NAME, "timeout", wrap("ls /workspace"), execOptions()),
      /initial/i,
    );
    await assert.rejects(
      () => fake.execFileHTTP(NAME, "bash", ["-c", "echo hi"], initOptions()),
      /script/i,
    );
    await assert.rejects(
      () => fake.execFileHTTP(NAME, "bash", ["-c", SEED], { ...initOptions(), input: undefined }),
      /archive/i,
    );
  } finally {
    done();
  }
});

test("deleting an absent Sprite is a 404 that the app tolerates", async () => {
  const { fake, done } = setup();
  try {
    await assert.rejects(() => fake.deleteSprite(NAME), /404 not found/);
  } finally {
    done();
  }
});

test("a refused call through the prototypes is recorded as a violation, a 404 is not", async () => {
  const { fake, done } = setup();
  try {
    const client: Record<string, unknown> = { sprite: (name: string) => ({ name }) };
    const sprite: Record<string, unknown> = {};
    const violations: Record<string, unknown>[] = [];
    patchSprites(fake, { client, sprite }, (entry) => violations.push(entry));
    await ready(fake);
    const create = client.createSprite as (this: unknown, ...args: unknown[]) => Promise<unknown>;
    const other = NAME.replace(/1$/, "2");
    assert.deepEqual(await create.call(client, other, CREATE), { name: other });
    const exec = sprite.execFile as (this: unknown, ...args: unknown[]) => Promise<unknown>;
    await assert.rejects(() => exec.call({ name: NAME }, "timeout", wrap("whoami"), execOptions()));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "fake-refused");
    assert.match(String(violations[0].message), /whoami/);
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    await assert.rejects(
      () =>
        exec.call(
          { name: NAME },
          "timeout",
          wrap("ls /workspace"),
          execOptions({ signal: stop.signal }),
        ),
      /^Error: stopped$/,
    );
    assert.equal(violations.length, 1, "an abort is not a refusal");
    const remove = client.deleteSprite as (...args: unknown[]) => Promise<unknown>;
    await assert.rejects(() => remove("ctf-absent"), /404/);
    assert.equal(violations.length, 1);
  } finally {
    done();
  }
});

const FIX = "git apply /workspace/fix-bug-1.patch";
const UPLOAD = 'curl -sS --data-binary @/tmp/flag.txt "$TARGET"';
const LONG = "sleep 30";
const scoreOptions = () => {
  const { env: _env, ...options } = execOptions({ signal: AbortSignal.timeout(60_000) });
  return options;
};

test("W3: base64 prints the flag encoded and the table holds the fix", async () => {
  const { fake, done } = setup();
  try {
    await ready(fake);
    const output = await fake.execFile(
      NAME,
      "timeout",
      wrap("base64 /tmp/flag.txt"),
      execOptions(),
    );
    assert.equal(output.stdout, `${Buffer.from(FLAG).toString("base64")}\n`);
    assert.equal(output.exitCode, 0);
    assert.ok(Object.hasOwn(COMMANDS, FIX));
  } finally {
    done();
  }
});

test("W3: the fix leaves a marker in the Sprite's directory", async () => {
  const { dir, fake, done } = setup();
  try {
    await ready(fake);
    assert.equal(existsSync(join(dir, NAME, "fixed")), false);
    const output = await fake.execFile(NAME, "timeout", wrap(FIX), execOptions());
    assert.deepEqual(output, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(existsSync(join(dir, NAME, "fixed")), true);
  } finally {
    done();
  }
});

test("W3: each seed scoring command fails, and the first passes once the fix is there", async () => {
  const { fake, done } = setup();
  try {
    await ready(fake);
    const score = async () =>
      Promise.all(
        SEED_BUGS.map(
          async (bug) =>
            (await fake.execFile(NAME, "timeout", wrap(seedScoreCommand(bug)), scoreOptions()))
              .exitCode,
        ),
      );
    assert.deepEqual(await score(), [1, 1, 1, 1]);
    await fake.execFile(NAME, "timeout", wrap(FIX), execOptions());
    assert.deepEqual(await score(), [0, 1, 1, 1]);
    const failed = await fake.execFile(
      NAME,
      "timeout",
      wrap(seedScoreCommand(SEED_BUGS[1])),
      scoreOptions(),
    );
    assert.notEqual(failed.stderr, "");
  } finally {
    done();
  }
});

test("W3: a scoring command takes no env, and a changed one is not accepted", async () => {
  const { fake, done } = setup();
  try {
    await ready(fake);
    const score = wrap(seedScoreCommand(SEED_BUGS[0]));
    await assert.rejects(() => fake.execFile(NAME, "timeout", score, execOptions()), /env/i);
    const changed = wrap(`${seedScoreCommand(SEED_BUGS[0])} || true`);
    await assert.rejects(() => fake.execFile(NAME, "timeout", changed, execOptions()), /command/i);
    await assert.rejects(
      () => fake.execFile(NAME, "timeout", wrap(FIX), scoreOptions()),
      /TARGET/,
      "an agent command still needs a TARGET",
    );
  } finally {
    done();
  }
});

async function receiver(status: number) {
  const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] =
    [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(status).end(status === 202 ? "Accepted\n" : "Request rejected\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, origin, close: () => server.close() };
}

test("W3: an upload posts the Sprite's flag to the app at the TARGET path, as the endpoint's host over https", async () => {
  const app = await receiver(202);
  const { fake, done } = setup({ appOrigin: app.origin });
  try {
    await ready(fake);
    const target = `https://${HOST}/v1/end/${"b".repeat(43)}`;
    const output = await fake.execFile(
      NAME,
      "timeout",
      wrap(UPLOAD),
      execOptions({ env: { TARGET: target } }),
    );
    assert.deepEqual(output, { stdout: "Accepted\n", stderr: "", exitCode: 0 });
    assert.equal(app.seen.length, 1);
    assert.equal(app.seen[0].method, "POST");
    assert.equal(app.seen[0].url, `/v1/end/${"b".repeat(43)}`);
    assert.equal(app.seen[0].headers.host, HOST);
    assert.equal(app.seen[0].headers["x-forwarded-proto"], "https");
    assert.equal(app.seen[0].body, FLAG);
  } finally {
    app.close();
    done();
  }
});

test("W3: an upload that the app refuses, or to an origin that is not loopback, throws", async () => {
  const app = await receiver(400);
  const refused = setup({ appOrigin: app.origin });
  try {
    await ready(refused.fake);
    await assert.rejects(
      () => refused.fake.execFile(NAME, "timeout", wrap(UPLOAD), execOptions()),
      /400|refus/i,
    );
  } finally {
    app.close();
    refused.done();
  }
  assert.throws(() => setup({ appOrigin: "https://example.com" }).done(), /origin/i);
});

test("W6: a long command waits for the abort and rejects with it, or rejects at its time bound", async () => {
  const { fake, done } = setup({ longBoundMs: 80 });
  try {
    await ready(fake);
    const stop = new AbortController();
    const running = fake.execFile(
      NAME,
      "timeout",
      wrap(LONG),
      execOptions({ signal: stop.signal }),
    );
    const raced = await Promise.race([
      running.then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]);
    assert.equal(raced, "waiting");
    stop.abort(new Error("stopped"));
    await assert.rejects(() => running, /abort/i);
    await assert.rejects(
      () => fake.execFile(NAME, "timeout", wrap(LONG), execOptions()),
      /time bound/i,
    );
    const already = new AbortController();
    already.abort(new Error("stopped"));
    await assert.rejects(
      () => fake.execFile(NAME, "timeout", wrap(LONG), execOptions({ signal: already.signal })),
      /abort/i,
    );
  } finally {
    done();
  }
});

test("W6: through the prototypes an abort rejects with the abort's own reason", async () => {
  const { fake, done } = setup({ longBoundMs: 5000 });
  try {
    const client: Record<string, unknown> = { sprite: (name: string) => ({ name }) };
    const sprite: Record<string, unknown> = {};
    const violations: Record<string, unknown>[] = [];
    patchSprites(fake, { client, sprite }, (entry) => violations.push(entry));
    await ready(fake);
    const exec = sprite.execFile as (this: unknown, ...args: unknown[]) => Promise<unknown>;
    const stop = new AbortController();
    const running = exec.call(
      { name: NAME },
      "timeout",
      wrap(LONG),
      execOptions({ signal: stop.signal }),
    );
    stop.abort(new Error("stopped"));
    await assert.rejects(() => running, /^Error: stopped$/);
    assert.deepEqual(violations, []);
  } finally {
    done();
  }
});

test("W6: calls to listSessions at the same instant each answer an empty list", async () => {
  const { fake, done } = setup();
  try {
    await ready(fake);
    const lists = await Promise.all(Array.from({ length: 8 }, () => fake.listSessions(NAME)));
    assert.deepEqual(
      lists,
      Array.from({ length: 8 }, () => []),
    );
    await assert.rejects(() => fake.listSessions("ctf-absent"), /unknown/i);
  } finally {
    done();
  }
});

test("W6: listSessions shows a session while the long command is pending, and none after an abort or the bound", async () => {
  const { fake, done } = setup({ longBoundMs: 150 });
  try {
    await ready(fake);
    assert.deepEqual(await fake.listSessions(NAME), []);
    const stop = new AbortController();
    const aborted = fake.execFile(
      NAME,
      "timeout",
      wrap(LONG),
      execOptions({ signal: stop.signal }),
    );
    const listed = await fake.listSessions(NAME);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].command, LONG);
    assert.equal(listed[0].isActive, true);
    assert.equal(
      (await Promise.all([fake.listSessions(NAME), fake.listSessions(NAME)])).flat().length,
      2,
    );
    stop.abort(new Error("stopped"));
    await assert.rejects(() => aborted, /abort/i);
    assert.deepEqual(await fake.listSessions(NAME), []);

    const bounded = fake.execFile(NAME, "timeout", wrap(LONG), execOptions());
    assert.equal((await fake.listSessions(NAME)).length, 1);
    await assert.rejects(() => bounded, /time bound/i);
    assert.deepEqual(await fake.listSessions(NAME), []);

    const already = new AbortController();
    already.abort(new Error("stopped"));
    await assert.rejects(() =>
      fake.execFile(NAME, "timeout", wrap(LONG), execOptions({ signal: already.signal })),
    );
    assert.deepEqual(await fake.listSessions(NAME), []);
  } finally {
    done();
  }
});
