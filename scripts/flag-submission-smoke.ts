// Opt-in deployment contract. This script never loads .env.local or calls model services.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SpritesClient, ExecError, APIError, type Sprite } from "@fly/sprites";
import { hashSecret } from "../lib/policy";
import {
  applySubmissionNetworkPolicy,
  checkpointEnvironment,
  restoreEnvironment,
} from "../lib/sprites";
import { classifyControlDenial, parseSmokeConfig } from "./flag-submission-smoke-contract";

type Result = { exitCode: number; output: string };
const started = Date.now();
let stage = "configuration";
const cancellation = new AbortController();
let interrupted = false;
function interrupt() {
  interrupted = true;
  stage = "interrupted";
  cancellation.abort();
}
function requireActive() {
  if (interrupted) throw new Error("Smoke interrupted.");
}
const report = (name: string, status: string, extra: Record<string, string | number> = {}) =>
  console.log(JSON.stringify({ name, status, ...extra }));

async function spriteCommand(
  sprite: Sprite,
  argv: string[],
  env?: Record<string, string>,
): Promise<Result> {
  try {
    const result = await sprite.execFile(argv[0], argv.slice(1), {
      timeout: 15_000,
      maxBuffer: 4096,
      signal: cancellation.signal,
      ...(env && { env }),
    });
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    if (error instanceof ExecError)
      return { exitCode: error.exitCode, output: `${error.stdout}${error.stderr}` };
    return { exitCode: -1, output: "" };
  }
}

async function exactPolicy(sprite: Sprite, hostname: string) {
  const policy = await sprite.getNetworkPolicy();
  assert.deepEqual(policy.rules, [
    { domain: hostname, action: "allow" },
    { domain: "*", action: "deny" },
  ]);
}

async function receiptCount(pool: Pool, gameId: string) {
  const {
    rows: [row],
  } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM ctf.flag_submissions WHERE game_id=$1",
    [gameId],
  );
  return row.count;
}

async function cleanDatabase(pool: Pool, gameId: string) {
  // The synthetic run is the only row this script owns. Never truncate or reconcile shared tables.
  await pool.query("DELETE FROM ctf.flag_submissions WHERE game_id=$1", [gameId]);
  await pool.query("DELETE FROM ctf.sprite_operations WHERE game_id=$1", [gameId]);
  await pool.query("DELETE FROM ctf.agent_sessions WHERE game_id=$1", [gameId]);
  await pool.query("DELETE FROM ctf.games WHERE id=$1", [gameId]);
}

async function cleanSprite(sprites: SpritesClient, name: string) {
  try {
    await sprites.deleteSprite(name);
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 404) return;
    throw error;
  }
}

async function main() {
  const config = parseSmokeConfig(process.env);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  const sprites = new SpritesClient(config.spriteToken, { timeout: 20_000 });
  const gameId = randomUUID();
  const lease = randomUUID();
  const operationId = randomUUID();
  const spriteName = `ctf-submission-smoke-${gameId}`;
  const token = randomBytes(32).toString("base64url");
  const flag = `flag{${randomBytes(24).toString("base64url")}}`;
  let sprite: Sprite | undefined;
  let creationAttempted = false;
  let insertionAttempted = false;
  let cleanupFailed = false;
  try {
    stage = "disposable database";
    const {
      rows: [identity],
    } = await pool.query<{ name: string }>("SELECT current_database() AS name");
    assert.equal(identity.name, process.env.CTF_SMOKE_DATABASE_NAME);
    const {
      rows: [existing],
    } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ctf.games");
    assert.equal(existing.count, 0, "Dedicated smoke database must contain no runs.");
    report("database", "ready", { database: identity.name });

    stage = "outside control preflight";
    requireActive();
    const reachable = await fetch(config.endpoint, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(reachable.status, 405, "The receiver did not reject GET /v1/end.");
    await reachable.body?.cancel();
    const unauthorized = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-CTF-Run-Id": randomUUID() },
      body: "smoke",
      redirect: "manual",
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(unauthorized.status, 401, "Public request without a capability was accepted.");
    assert.equal(unauthorized.headers.get("cache-control"), "no-store");
    await unauthorized.body?.cancel();
    const control = await fetch(config.controlUrl, {
      redirect: "manual",
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]),
    });
    const controlStatus = control.status;
    assert.equal(controlStatus, 200, "Unrelated public HTTPS control is unavailable.");
    await control.body?.cancel();
    report("outside-control", "ready");

    stage = "sprite policy and restore";
    requireActive();
    creationAttempted = true;
    sprite = await sprites.createSprite(spriteName, {
      config: { ramMB: 512, cpus: 1 },
      urlSettings: { auth: "sprite", privateAccess: "admins" },
      labels: ["ctf-submission-smoke"],
    });
    await sprite.updateNetworkPolicy({ rules: [{ domain: "*", action: "deny" }] });
    assert.deepEqual((await sprite.getNetworkPolicy()).rules, [{ domain: "*", action: "deny" }]);
    requireActive();
    const checkpoint = await checkpointEnvironment(spriteName);
    requireActive();
    await applySubmissionNetworkPolicy(spriteName, config.hostname);
    await exactPolicy(sprite, config.hostname);
    await restoreEnvironment(spriteName, checkpoint, config.endpoint);
    await exactPolicy(sprite, config.hostname);
    report("policy-restore", "passed");

    const allowedHost = await spriteCommand(sprite, [
      "curl",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--output",
      "/dev/null",
      "--write-out",
      "HTTP:%{http_code}",
      "--url",
      config.endpoint,
    ]);
    assert.equal(allowedHost.exitCode, 0);
    assert.equal(allowedHost.output.trim(), "HTTP:405");
    report("allowed-submission-host", "reachable");

    stage = "unrelated host denial";
    const deniedControl = await spriteCommand(sprite, [
      "curl",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--output",
      "/dev/null",
      "--write-out",
      "HTTP:%{http_code}",
      "--url",
      config.controlUrl,
    ]);
    assert.ok(
      classifyControlDenial(controlStatus, deniedControl),
      "Unrelated HTTPS host was not explicitly denied.",
    );
    report("unrelated-control", "denied");

    stage = "synthetic dispatch";
    requireActive();
    insertionAttempted = true;
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,
         monitor_version,status,token_budget,agent_effort,system_prompt,monitor_mode,submission_transport)
       VALUES($1,$2,$3,$4,'smoke-agent','smoke-monitor','smoke','active',1000,'medium','','async','http')`,
      [gameId, `smoke-${gameId}`, spriteName, hashSecret(flag)],
    );
    await pool.query(
      `INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,lease,lease_until)
       VALUES($1,$1,1,'smoke-agent','medium','',$2,now()+interval '15 minutes')`,
      [gameId, lease],
    );
    await pool.query(
      `INSERT INTO ctf.sprite_operations(id,sprite_name,game_id,session_id,tool_call_id,kind,command,
         execution_generation,submission_token_hash,originating_lease)
       VALUES($1,$2,$3,$3,'smoke-upload','command','curl --data-binary @/tmp/flag.txt',0,$4,$5)`,
      [operationId, spriteName, gameId, createHash("sha256").update(token).digest("hex"), lease],
    );
    const seeded = await sprite.execFileHTTP("sh", ["-c", "umask 077; cat > /tmp/flag.txt"], {
      input: Buffer.from(flag),
      timeout: 20_000,
      maxBuffer: 1024,
    });
    assert.equal(seeded.exitCode, 0);

    stage = "file upload and replay";
    requireActive();
    const env = {
      CTF_SUBMISSION_TOKEN: token,
      CTF_SMOKE_RUN_ID: gameId,
      TARGET: config.endpoint,
    };
    const responseLoss = await spriteCommand(
      sprite,
      [
        "python3",
        "-c",
        "import os,ssl,socket,urllib.parse; u=urllib.parse.urlsplit(os.environ['TARGET']); b=open('/tmp/flag.txt','rb').read(); h=u.hostname; s=ssl.create_default_context().wrap_socket(socket.create_connection((h,443),8),server_hostname=h); r=('POST '+u.path+' HTTP/1.1\\r\\nHost: '+h+'\\r\\nContent-Type: application/octet-stream\\r\\nX-CTF-Run-Id: '+os.environ['CTF_SMOKE_RUN_ID']+'\\r\\nAuthorization: Bearer '+os.environ['CTF_SUBMISSION_TOKEN']+'\\r\\nContent-Length: '+str(len(b))+'\\r\\nConnection: close\\r\\n\\r\\n').encode()+b; s.sendall(r); s.close()",
      ],
      env,
    );
    assert.equal(responseLoss.exitCode, 0);
    report("response-loss-attempt", "sent");
    const upload = [
      "sh",
      "-c",
      'curl --silent --show-error --max-time 10 --output /dev/null --write-out "HTTP:%{http_code}" --header "Content-Type: application/octet-stream" --header "X-CTF-Run-Id: $CTF_SMOKE_RUN_ID" --header "Authorization: Bearer $CTF_SUBMISSION_TOKEN" --data-binary @/tmp/flag.txt "$TARGET"',
    ];
    const retry = await spriteCommand(sprite, upload, env);
    assert.equal(retry.exitCode, 0);
    assert.equal(retry.output.trim(), "HTTP:202");
    assert.equal(await receiptCount(pool, gameId), 1);
    const committedReplay = await spriteCommand(sprite, upload, env);
    assert.equal(committedReplay.exitCode, 0);
    assert.equal(committedReplay.output.trim(), "HTTP:202");
    assert.equal(await receiptCount(pool, gameId), 1);
    const {
      rows: [receipt],
    } = await pool.query<{ correct: boolean }>(
      "SELECT correct FROM ctf.flag_submissions WHERE game_id=$1",
      [gameId],
    );
    assert.equal(receipt.correct, true);
    await pool.query(
      "UPDATE ctf.sprite_operations SET status='completed',output='',completed_at=now() WHERE id=$1",
      [operationId],
    );
    await pool.query(
      "UPDATE ctf.agent_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",
      [gameId],
    );
    const lateReplay = await spriteCommand(sprite, upload, env);
    assert.equal(lateReplay.exitCode, 0);
    assert.equal(lateReplay.output.trim(), "HTTP:202");
    assert.equal(await receiptCount(pool, gameId), 1);
    report("file-upload-replay", "passed", { receipts: 1 });
    requireActive();
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        try {
          if (insertionAttempted) await cleanDatabase(pool, gameId);
        } finally {
          await pool.end();
        }
      })(),
      creationAttempted ? cleanSprite(sprites, spriteName) : Promise.resolve(),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      stage = "cleanup";
      report("cleanup", "failed", { sprite: spriteName });
      cleanupFailed = true;
    } else {
      report("cleanup", "passed", { sprite: spriteName });
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (cleanupFailed) throw new Error("Owned resource cleanup failed.");
  requireActive();
  report("sprite-contract", "passed", { elapsedMs: Date.now() - started });
}

main().catch(() => {
  // Error messages and probe output may contain operator credentials or the synthetic flag.
  report(interrupted ? "interrupted" : stage, "failed");
  process.exitCode = 1;
});
