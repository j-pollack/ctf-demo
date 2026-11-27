import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sprite-fake-"));
  return {
    dir,
    fake: createSpriteFake({ dir, host: HOST }),
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
