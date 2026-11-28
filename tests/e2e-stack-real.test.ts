import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// The stack module reads its environment, so each case imports it in a child process whose
// environment holds only what the case gives it.
const STACK = pathToFileURL("tests/e2e/stack.ts").href;
const RUN = pathToFileURL("tests/e2e/run.ts").href;

async function run(env: Record<string, string>, body = "") {
  const script = `const stack = await import(${JSON.stringify(STACK)}); ${body}
    console.log("done");`;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env } },
    );
    return { ok: stdout.includes("done"), stderr: "" };
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: string }).stderr) };
  }
}

const REAL = { E2E_STACK: "real", E2E_BASE_URL: "https://staging.example" };

test("real mode refuses an http base URL", async () => {
  const result = await run({ ...REAL, E2E_BASE_URL: "http://staging.example" });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /E2E_BASE_URL must be an https URL/);
});

test("real mode imports with none of the faked stack's variables", async () => {
  assert.deepEqual(await run(REAL, `await import(${JSON.stringify(RUN)});`), {
    ok: true,
    stderr: "",
  });
});

test("real mode answers with the staging values", async () => {
  const result = await run(
    REAL,
    `const assert = (await import("node:assert/strict")).default;
     assert.equal(stack.newEmail("a"), "delivered@resend.dev");
     assert.deepEqual(stack.visitorHeaders(), { "x-vercel-skip-toolbar": "1" });
     assert.deepEqual(stack.takeViolations(), []);
     assert.deepEqual(stack.takeServerFailures(), []);
     assert.deepEqual(stack.takeWorkerFailures(), []);`,
  );
  assert.deepEqual(result, { ok: true, stderr: "" });
});

test("real mode throws from the helpers that have no real form", async () => {
  const result = await run(
    REAL,
    `const assert = (await import("node:assert/strict")).default;
     await assert.rejects(stack.mailTo("a@b.c", "s"));
     await assert.rejects(stack.threadIdOf("m"));
     await assert.rejects(stack.grantAdmin("a@b.c"));
     assert.throws(() => stack.contactEmail());
     assert.throws(() => stack.pool(), /E2E_DATABASE_URL is not set[.] Use npm run test:e2e:real[.]/);`,
  );
  assert.deepEqual(result, { ok: true, stderr: "" });
});

test("an unset stack still demands the faked stack's variables when it uses them", async () => {
  const result = await run({ E2E_BASE_URL: "http://127.0.0.1:3000" }, "stack.takeViolations();");
  assert.equal(result.ok, false);
  assert.match(result.stderr, /E2E_VIOLATIONS_FILE is not set\. Use npm run test:e2e\./);
});
