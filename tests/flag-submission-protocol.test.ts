import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuredFlagEndpoint,
  decodeSubmissionBody,
  flagEndpointUrl,
  parseSubmissionRequest,
  validateFlagEndpoint,
} from "../lib/flag-submission-protocol";

const gameId = "bb8373cb-9fef-4e5a-9a6d-e307d421ab22";
const headers = {
  "Content-Type": "application/octet-stream",
  Authorization: "Bearer one-time-token",
  "X-CTF-Run-Id": gameId,
};

test("accepts only an unambiguous authorized upload", () => {
  assert.deepEqual(parseSubmissionRequest(new Headers(headers)), {
    gameId,
    token: "one-time-token",
  });
  // Web Headers joins repeats with a comma, which no longer matches a single bearer.
  const repeated = new Headers(headers);
  repeated.append("Authorization", "Bearer other");
  assert.deepEqual(parseSubmissionRequest(repeated), { status: 401 });
  assert.deepEqual(
    parseSubmissionRequest(new Headers({ ...headers, Origin: "https://example.test" })),
    { status: 400 },
  );
  assert.deepEqual(
    parseSubmissionRequest(new Headers({ ...headers, "Transfer-Encoding": "chunked, chunked" })),
    { status: 400 },
  );
  assert.deepEqual(
    parseSubmissionRequest(new Headers({ ...headers, "Content-Type": "text/plain" })),
    { status: 415 },
  );
  assert.deepEqual(parseSubmissionRequest(new Headers({ ...headers, "Content-Length": "8193" })), {
    status: 413,
  });
});

test("bounded UTF-8 body rejects invalid, empty and oversized input", () => {
  assert.equal(decodeSubmissionBody([Buffer.from("flag{a}"), Buffer.from("\n")]), "flag{a}\n");
  assert.equal(decodeSubmissionBody([Buffer.from([0xc3, 0x28])]), null);
  assert.equal(decodeSubmissionBody([]), null);
  assert.equal(decodeSubmissionBody([Buffer.alloc(8193)]), null);
  assert.equal(decodeSubmissionBody([Buffer.from([0xef, 0xbb, 0xbf, 0x61])]), "\ufeffa");
});

test("configured endpoint is exact HTTPS on a canonical DNS host", () => {
  assert.deepEqual(validateFlagEndpoint("https://submit.ctf.example/v1/end"), {
    url: "https://submit.ctf.example/v1/end",
    hostname: "submit.ctf.example",
  });
  for (const url of [
    "https://127.0.0.1/v1/end",
    "https://localhost/v1/end",
    "http://submit.ctf.example/v1/end",
    "https://submit.ctf.example:8443/v1/end",
    "https://submit.ctf.example/v1/../v1/end",
    "https://submit.ctf.example/v1/%65nd",
    "https://submit.ctf.example/v1/end?x=1",
    "https://submit.ctf.example/v1/end#x",
    "https://*.example.test/v1/end",
    "https://a.*.example.test/v1/end",
    "https://submit.ctf.example./v1/end",
    "https://bad_label.example.test/v1/end",
    "https://-submit.example.test/v1/end",
    "https://submit-.example.test/v1/end",
  ])
    assert.throws(() => validateFlagEndpoint(url), url);
});

test("trusted origin resolver selects explicit, production and immutable deployment hosts", () => {
  const deployment = {
    VERCEL_ENV: "preview",
    VERCEL_URL: "preview-123.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "app.example.test",
  };
  assert.deepEqual(
    configuredFlagEndpoint({ ...deployment, SITE_URL: "https://tunnel.example.test/" }),
    {
      url: "https://tunnel.example.test/v1/end",
      hostname: "tunnel.example.test",
    },
  );
  assert.deepEqual(configuredFlagEndpoint(deployment), {
    url: "https://preview-123.vercel.app/v1/end",
    hostname: "preview-123.vercel.app",
  });
  assert.deepEqual(configuredFlagEndpoint({ ...deployment, VERCEL_ENV: "production" }), {
    url: "https://app.example.test/v1/end",
    hostname: "app.example.test",
  });
  assert.deepEqual(
    configuredFlagEndpoint({ VERCEL_ENV: "production", VERCEL_URL: "immutable.vercel.app" }),
    {
      url: "https://immutable.vercel.app/v1/end",
      hostname: "immutable.vercel.app",
    },
  );
});

test("selected unsafe origin fails without falling back", () => {
  const fallback = {
    VERCEL_ENV: "production",
    VERCEL_URL: "immutable.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "app.example.test",
  };
  for (const site of [
    "http://tunnel.example.test",
    "https://tunnel.example.test:8443",
    "https://tunnel.example.test/path",
    "https://tunnel.example.test/?x=1",
    "https://tunnel.example.test/#hash",
    "https://user@tunnel.example.test",
    "https://*.example.test",
    "https://tunnel.example.test.",
    "https://127.0.0.1",
    "https://localhost",
  ])
    assert.throws(() => configuredFlagEndpoint({ ...fallback, SITE_URL: site }), site);
  assert.throws(() =>
    configuredFlagEndpoint({ ...fallback, VERCEL_PROJECT_PRODUCTION_URL: "*.example.test" }),
  );
  assert.throws(() =>
    configuredFlagEndpoint({
      VERCEL_ENV: "preview",
      VERCEL_URL: "bad/host",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example.test",
    }),
  );
  assert.throws(() =>
    configuredFlagEndpoint({
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example.test",
    }),
  );
});

test("the display URL is null when the endpoint is not configured", () => {
  const saved = { ...process.env };
  try {
    for (const name of ["SITE_URL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"])
      delete process.env[name];
    assert.equal(flagEndpointUrl(), null);
    process.env.SITE_URL = "https://tunnel.example.test";
    assert.equal(flagEndpointUrl(), "https://tunnel.example.test/v1/end");
  } finally {
    process.env = saved;
  }
});
