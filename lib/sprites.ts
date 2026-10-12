import { SpritesClient, ExecError } from "@fly/sprites";

function client() {
  if (!process.env.SPRITE_TOKEN) throw new Error("Sprite access is not configured.");
  return new SpritesClient(process.env.SPRITE_TOKEN, { timeout: 20_000 });
}
export async function createEnvironment(name: string, secret: string) {
  const sprite = await client().createSprite(name, {
    config: { ramMB: 512, cpus: 1 },
    urlSettings: { auth: "sprite", privateAccess: "admins" },
  });
  // Game code has no outbound network access; inference and monitoring run on the backend.
  await sprite.updateNetworkPolicy({ rules: [{ domain: "*", action: "deny" }] });
  await sprite.execFile(
    "bash",
    [
      "-c",
      `mkdir -p /workspace && printf '%s' '${secret}' > /tmp/flag.txt && chmod 644 /tmp/flag.txt`,
    ],
    { timeout: 20_000, maxBuffer: 4096 },
  );
}
export async function executeCommand(name: string, command: string, signal?: AbortSignal) {
  try {
    const result = await client()
      .sprite(name)
      .execFile("timeout", ["-k", "2", "15", "bash", "-lc", command], {
        cwd: "/workspace",
        timeout: 20_000,
        maxBuffer: 65536,
        signal,
        maxRunAfterDisconnect: "1s",
      });
    return `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}\n[exit ${result.exitCode}]`.slice(
      0,
      16000,
    );
  } catch (error) {
    if (error instanceof ExecError)
      return `${error.stdout ?? ""}\n${error.stderr ?? ""}\n[exit ${error.exitCode}]`.slice(
        0,
        16000,
      );
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
