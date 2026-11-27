import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "./agent-script";

type Entry = Record<string, unknown>;
type Options = Record<string, unknown> & { input?: unknown; signal?: AbortSignal };

const NAME = /^ctf-[0-9a-f-]{36}$/;
const CREATE = {
  config: { ramMB: 512, cpus: 1 },
  urlSettings: { auth: "sprite", privateAccess: "admins" },
};
const SEED =
  /^mkdir -p \/workspace && tar -xzf - -C \/workspace && printf '%s' '(flag\{[\w-]{32}\})' > \/tmp\/flag\.txt && chmod 644 \/tmp\/flag\.txt$/;

// The one error the app tolerates when it deletes a Sprite twice. It is not a refusal.
export class NotFound extends Error {
  constructor(name: string) {
    super(`404 not found: ${name}`);
  }
}

// A command the app aborted. It is the app's own stop, so it is not a refusal.
class Aborted extends Error {
  constructor(readonly reason: unknown) {
    super("The command was aborted.");
  }
}

// A Sprite as a directory holding its flag and its network policy, so a second process can read it.
// Every method validates what the app sends and throws on anything it does not expect.
export function createSpriteFake({ dir, host }: { dir: string; host: string }) {
  const at = (name: string, file = "") => join(dir, name, file);
  const known = (name: string) => assert.ok(existsSync(at(name)), `Unknown Sprite ${name}`);
  const policy = (name: string) => {
    assert.ok(existsSync(at(name, "policy.json")), `No network policy for ${name}`);
    return JSON.parse(readFileSync(at(name, "policy.json"), "utf8"));
  };
  const flagOf = (name: string) => {
    assert.ok(existsSync(at(name, "flag")), `Sprite ${name} is not initialised`);
    return readFileSync(at(name, "flag"), "utf8");
  };
  return {
    async createSprite(name: string, options: unknown) {
      assert.match(name, NAME, "Unexpected Sprite name");
      assert.deepEqual(options, CREATE, "Unexpected create options");
      mkdirSync(dir, { recursive: true });
      mkdirSync(at(name)); // throws EEXIST: a Sprite is created once
    },
    async deleteSprite(name: string) {
      if (!existsSync(at(name))) throw new NotFound(name);
      rmSync(at(name), { recursive: true });
    },
    async updateNetworkPolicy(name: string, next: unknown) {
      known(name);
      const rules = [
        { domain: host, action: "allow" },
        { domain: "*", action: "deny" },
      ];
      assert.deepEqual(next, { rules }, "Unexpected network policy");
      writeFileSync(at(name, "policy.json"), JSON.stringify(next));
    },
    async getNetworkPolicy(name: string) {
      known(name);
      return policy(name);
    },
    async execFileHTTP(name: string, file: string, args: string[], options: Options) {
      known(name);
      policy(name);
      assert.equal(file, "bash");
      assert.equal(args.length, 2);
      assert.equal(args[0], "-c");
      assert.equal(options.timeout, 20_000);
      assert.equal(options.maxBuffer, 4096);
      const flag = args[1].match(SEED)?.[1];
      assert.ok(flag, "Unexpected initialisation script");
      assert.ok(Buffer.isBuffer(options.input) && options.input.length > 0, "No seed archive");
      writeFileSync(at(name, "flag"), flag);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async execFile(name: string, file: string, args: string[], options: Options) {
      known(name);
      const flag = flagOf(name);
      assert.equal(file, "timeout", "Commands run under timeout");
      assert.deepEqual(args.slice(0, 5), ["-k", "2", "15", "bash", "-lc"], "Unexpected exec form");
      assert.equal(args.length, 6, "Unexpected exec form");
      assert.equal(options.cwd, "/workspace", "Unexpected cwd");
      assert.equal(options.timeout, 20_000);
      assert.equal(options.maxBuffer, 65536);
      assert.equal(options.maxRunAfterDisconnect, "1s", "Unexpected maxRunAfterDisconnect");
      assert.ok(options.signal, "Commands are abortable");
      assert.deepEqual(Object.keys(options.env ?? {}), ["TARGET"], "Only TARGET is passed");
      const target = (options.env as Record<string, string>).TARGET;
      assert.ok(target.startsWith(`https://${host}/v1/end/`), "TARGET names the submission URL");
      if (options.signal.aborted) throw new Aborted(options.signal.reason);
      const output = Object.hasOwn(COMMANDS, args[5]) ? COMMANDS[args[5]] : undefined;
      assert.ok(output, `Unexpected command: ${args[5]}`);
      return { stdout: output(flag), stderr: "", exitCode: 0 };
    },
    async listSessions(name: string) {
      known(name);
      return [];
    },
  };
}

export type SpriteFake = ReturnType<typeof createSpriteFake>;
type Method = (this: unknown, ...args: unknown[]) => Promise<unknown>;

// Replaces the methods on the two prototypes. Every refusal leaves a violation, because these calls
// run outside the fetch guard.
export function patchSprites(
  fake: SpriteFake,
  prototypes: { client: Record<string, unknown>; sprite: Record<string, unknown> },
  violation: (entry: Entry) => void,
) {
  const guarded = (method: string, run: Method): Method =>
    async function (this: unknown, ...args) {
      try {
        return await run.apply(this, args);
      } catch (error) {
        if (error instanceof Aborted) throw error.reason;
        if (!(error instanceof NotFound))
          violation({
            kind: "fake-refused",
            method,
            message: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    };
  const bySprite = (name: keyof SpriteFake): Method =>
    function (this: unknown, ...args) {
      const self = this as { name: string };
      return (fake[name] as (...a: unknown[]) => Promise<unknown>)(self.name, ...args);
    };
  prototypes.client.createSprite = guarded(
    "createSprite",
    async function (this: unknown, name, options) {
      await fake.createSprite(name as string, options);
      return (this as { sprite: (name: string) => unknown }).sprite(name as string);
    },
  );
  prototypes.client.deleteSprite = guarded("deleteSprite", async (name) =>
    fake.deleteSprite(name as string),
  );
  for (const name of [
    "updateNetworkPolicy",
    "getNetworkPolicy",
    "execFileHTTP",
    "execFile",
    "listSessions",
  ] as const)
    prototypes.sprite[name] = guarded(name, bySprite(name));
}
