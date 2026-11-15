import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyControlDenial, parseSmokeConfig } from "../scripts/flag-submission-smoke-contract";

const env = {
  CTF_SMOKE_DISPOSABLE: "1",
  CTF_SMOKE_DATABASE_URL: "postgresql://smoke@db.example.test/ctf_smoke_flag_http",
  CTF_SMOKE_DATABASE_NAME: "ctf_smoke_flag_http",
  SITE_URL: "https://flags.example.test",
  CTF_SMOKE_CONTROL_URL: "https://owned-control.example.test/health",
  SPRITE_TOKEN: "synthetic-token",
};

test("Sprite submission smoke uses the configured site target and unrelated HTTPS control", () => {
  assert.equal(parseSmokeConfig(env).endpoint, "https://flags.example.test/v1/end");
  assert.equal(parseSmokeConfig(env).hostname, "flags.example.test");
  assert.equal(parseSmokeConfig(env).controlUrl, env.CTF_SMOKE_CONTROL_URL);
  assert.throws(
    () => parseSmokeConfig({ ...env, CTF_SMOKE_DISPOSABLE: "" }),
    /CTF_SMOKE_DISPOSABLE/,
  );
  assert.throws(
    () => parseSmokeConfig({ ...env, CTF_SMOKE_DATABASE_NAME: "shared" }),
    /CTF_SMOKE_DATABASE_NAME/,
  );
  assert.throws(() => parseSmokeConfig({ ...env, SITE_URL: "http://flags.example.test" }));
  assert.throws(() => parseSmokeConfig({ ...env, SITE_URL: "" }));
  assert.throws(
    () => parseSmokeConfig({ ...env, CTF_SMOKE_CONTROL_URL: "" }),
    /CTF_SMOKE_CONTROL_URL/,
  );
  assert.throws(
    () =>
      parseSmokeConfig({
        ...env,
        CTF_SMOKE_CONTROL_URL: "http://owned-control.example.test/health",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      parseSmokeConfig({
        ...env,
        CTF_SMOKE_CONTROL_URL: "https://flags.example.test/health",
      }),
    /unrelated/,
  );
});

test("disposable database connection always verifies the server certificate", () => {
  const base = env.CTF_SMOKE_DATABASE_URL;
  assert.equal(
    new URL(parseSmokeConfig(env).databaseUrl).searchParams.get("sslmode"),
    "verify-full",
  );
  const neon = `${base}?sslmode=verify-full&channel_binding=require`;
  assert.equal(parseSmokeConfig({ ...env, CTF_SMOKE_DATABASE_URL: neon }).databaseUrl, neon);
  assert.equal(
    new URL(
      parseSmokeConfig({ ...env, CTF_SMOKE_DATABASE_URL: `${base}?channel_binding=require` })
        .databaseUrl,
    ).searchParams.get("sslmode"),
    "verify-full",
  );
  for (const query of [
    "sslmode=disable",
    "sslmode=require",
    "sslmode=verify-ca",
    "sslmode=prefer",
    "sslmode=verify-full&sslmode=disable",
    "channel_binding=prefer",
    "sslmode=verify-full&options=-c",
  ])
    assert.throws(
      () => parseSmokeConfig({ ...env, CTF_SMOKE_DATABASE_URL: `${base}?${query}` }),
      /TLS|query/,
    );
});

test("control denial needs a working outside 200 and explicit Sprite refusal", () => {
  assert.equal(
    classifyControlDenial(200, { exitCode: 7, output: "curl: (7) Failed to connect; HTTP:000" }),
    true,
  );
  assert.equal(
    classifyControlDenial(503, { exitCode: 7, output: "curl: (7) Failed to connect; HTTP:000" }),
    false,
  );
  assert.equal(
    classifyControlDenial(200, {
      exitCode: 28,
      output: "curl: (28) Operation timed out; HTTP:000",
    }),
    false,
  );
  assert.equal(classifyControlDenial(200, { exitCode: 0, output: "HTTP:200" }), false);
  assert.equal(
    classifyControlDenial(200, { exitCode: 7, output: "curl: (7) Failed to connect; HTTP:200" }),
    false,
  );
});
