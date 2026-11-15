import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SpritesClient, ExecError, type CheckpointStream, type RestoreStream } from "@fly/sprites";
import { validateFlagEndpoint } from "./flag-submission-protocol";

// Every command runs here, so it is also the working directory the agent is told about.
export const SPRITE_WORKDIR = "/workspace";

function client() {
  if (!process.env.SPRITE_TOKEN) throw new Error("Sprite access is not configured.");
  return new SpritesClient(process.env.SPRITE_TOKEN, { timeout: 20_000 });
}
export async function applySubmissionNetworkPolicy(name: string, hostname: string) {
  const sprite = client().sprite(name);
  const rules = [
    { domain: hostname, action: "allow" as const },
    { domain: "*", action: "deny" as const },
  ];
  await sprite.updateNetworkPolicy({ rules });
  const applied = await sprite.getNetworkPolicy();
  if (JSON.stringify(applied.rules) !== JSON.stringify(rules))
    throw new Error("Submission network policy could not be verified.");
}

export async function createEnvironment(name: string, secret: string, submissionUrl?: string) {
  const sprite = await client().createSprite(name, {
    config: { ramMB: 512, cpus: 1 },
    urlSettings: { auth: "sprite", privateAccess: "admins" },
  });
  if (submissionUrl) {
    await applySubmissionNetworkPolicy(name, validateFlagEndpoint(submissionUrl).hostname);
  } else {
    await sprite.updateNetworkPolicy({ rules: [{ domain: "*", action: "deny" }] });
  }
  // stdin carries the seed workspace (see lib/seed.ts); the flag is written in the same call.
  await sprite.execFileHTTP(
    "bash",
    [
      "-c",
      `mkdir -p /workspace && tar -xzf - -C /workspace && printf '%s' '${secret}' > /tmp/flag.txt && chmod 644 /tmp/flag.txt`,
    ],
    {
      input: await readFile(join(process.cwd(), "seed/workspace.tar.gz")),
      timeout: 20_000,
      maxBuffer: 4096,
    },
  );
}
// The text an agent sees for one finished command. A failed command lists stderr without the
// [stderr] label. The flag-read scenario executor reuses this so generated transcripts match.
export function commandOutput(stdout: string | Buffer, stderr: string | Buffer, exitCode: number) {
  const body =
    exitCode === 0 ? `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}` : `${stdout}\n${stderr}`;
  return `${body}\n[exit ${exitCode}]`.slice(0, 16000);
}
export async function executeCommand(
  name: string,
  command: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
) {
  try {
    const result = await client()
      .sprite(name)
      .execFile("timeout", ["-k", "2", "15", "bash", "-lc", command], {
        cwd: SPRITE_WORKDIR,
        timeout: 20_000,
        maxBuffer: 65536,
        signal,
        maxRunAfterDisconnect: "1s",
        ...(env && { env }),
      });
    return commandOutput(result.stdout, result.stderr, result.exitCode);
  } catch (error) {
    if (error instanceof ExecError)
      return commandOutput(error.stdout ?? "", error.stderr ?? "", error.exitCode);
    throw new Error("The command could not finish in this run’s environment.");
  }
}
export async function destroyEnvironment(name: string) {
  try {
    await client().deleteSprite(name);
  } catch (error) {
    if (error instanceof Error && /404|not found/i.test(error.message)) return;
    throw error;
  }
}

// How long a checkpoint or restore may run before its stream is closed and it counts as failed.
export const operationTimeout = { ms: 30_000 };
// The text of the stream's terminal `complete` message. An `error` message, an end without a
// terminal message, or a closed (timed-out) stream is a failure; nothing is assumed to have happened.
async function completion(stream: CheckpointStream | RestoreStream, what: string) {
  const timer = setTimeout(() => stream.close(), operationTimeout.ms);
  try {
    for (let message; (message = await stream.next());) {
      if (message.type === "error") throw new Error(`${what} failed.`);
      if (message.type === "complete") return message.data ?? "";
    }
    throw new Error(`${what} did not finish.`);
  } finally {
    clearTimeout(timer);
    stream.close();
  }
}
// Snapshots the sprite and returns the checkpoint id (e.g. "v2").
export async function checkpointEnvironment(name: string) {
  const done = await completion(await client().sprite(name).createCheckpoint(), "Checkpoint");
  const id = done.match(/^Checkpoint (v\d+) created/)?.[1];
  if (!id) throw new Error("Checkpoint did not report an id.");
  return id;
}
export async function restoreEnvironment(name: string, id: string, submissionUrl?: string) {
  await completion(await client().sprite(name).restoreCheckpoint(id), "Restore");
  if (submissionUrl)
    await applySubmissionNetworkPolicy(name, validateFlagEndpoint(submissionUrl).hostname);
}
