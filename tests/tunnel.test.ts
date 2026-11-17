import assert from "node:assert/strict";
import { test } from "node:test";
import { tunnelError, tunnelUrl } from "../scripts/tunnel";

// Shapes copied from `ngrok http <port> --log=stdout --log-format=json` (ngrok 3.39).
const started =
  '{"addr":"http://localhost:3001","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-11-16T14:28:46.841189-08:00","url":"https://abc-123.ngrok-free.app"}';

test("the public URL comes only from ngrok's started-tunnel line", () => {
  assert.equal(tunnelUrl(started), "https://abc-123.ngrok-free.app");
  for (const line of [
    '{"err":"\\u003cnil\\u003e","lvl":"info","msg":"open config file","path":"/x/ngrok.yml"}',
    started.replace("https://", "http://"),
    started.replace('"started tunnel"', '"tunnel session started"'),
    "not json",
    "",
  ])
    assert.equal(tunnelUrl(line), undefined, line);
});

test("ngrok error lines surface their message", () => {
  assert.equal(
    tunnelError(
      '{"err":"authentication failed: Your account is limited to 1 simultaneous ngrok agent sessions.\\n\\nERR_NGROK_108\\n","lvl":"eror","msg":"failed to reconnect session"}',
    ),
    "authentication failed: Your account is limited to 1 simultaneous ngrok agent sessions. ERR_NGROK_108",
  );
  assert.equal(tunnelError(started), undefined);
  assert.equal(tunnelError('{"err":"\\u003cnil\\u003e","lvl":"info","msg":"x"}'), undefined);
});
