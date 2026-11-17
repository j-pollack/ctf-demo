import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const START_TIMEOUT_MS = 20_000;

function logLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The public HTTPS URL from ngrok's JSON "started tunnel" log line. */
export function tunnelUrl(line: string): string | undefined {
  const log = logLine(line);
  return log?.msg === "started tunnel" &&
    typeof log.url === "string" &&
    log.url.startsWith("https://")
    ? log.url
    : undefined;
}

/** The message from an ngrok error log line, on one line. */
export function tunnelError(line: string): string | undefined {
  const log = logLine(line);
  if (log?.lvl !== "eror" || typeof log.err !== "string") return undefined;
  return log.err.replace(/\s+/g, " ").trim();
}

/**
 * Starts `ngrok http <port>` and resolves with its public URL, or with an error message when
 * ngrok is missing, fails, or reports no tunnel in time. The caller owns the child on success.
 */
export function startTunnel(
  port: number,
): Promise<{ child: ChildProcess; url: string } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "ngrok",
      ["http", String(port), "--inspect=false", "--log=stdout", "--log-format=json"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let lastError = "";
    const fail = (error: string) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve({ error });
    };
    const timer = setTimeout(
      () => fail(lastError || "ngrok did not report a tunnel within 20 seconds."),
      START_TIMEOUT_MS,
    );
    // Keep reading after the URL arrives, so ngrok never blocks on a full pipe.
    createInterface({ input: child.stdout! }).on("line", (line) => {
      lastError = tunnelError(line) ?? lastError;
      const url = tunnelUrl(line);
      if (!url) return;
      clearTimeout(timer);
      resolve({ child, url });
    });
    child.once("error", (error) =>
      fail(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "ngrok is not installed."
          : error.message,
      ),
    );
    child.once("exit", () => fail(lastError || "ngrok exited before starting a tunnel."));
  });
}
