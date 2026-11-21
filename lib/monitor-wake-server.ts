import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleepFor } from "node:timers/promises";
import { db } from "./db";
import { WAKE_KEY, type WakeRegistration } from "./worker-wake";

const FLY_PORT = 8080;
const UNREGISTER_RETRY_MS = 1_000;

function authorized(request: IncomingMessage, token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Serves POST /wake and POST /drain and registers its address in ctf.settings so the app can find
// this worker.
export async function startWakeEndpoint(onWake: () => void, onDrain: () => void) {
  const token = randomBytes(32).toString("hex");
  const fly = process.env.FLY_APP_NAME;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    if (request.method !== "POST" || (request.url !== "/wake" && request.url !== "/drain")) {
      response.writeHead(404).end();
    } else if (!authorized(request, token)) {
      response.writeHead(401).end();
    } else {
      (request.url === "/wake" ? onWake : onDrain)();
      response.writeHead(204).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Fly's proxy reaches the machine on every interface. Elsewhere only this host may call.
    server.listen(fly ? FLY_PORT : 0, fly ? "0.0.0.0" : "127.0.0.1", resolve);
  });
  const registration: WakeRegistration = fly
    ? {
        url: `https://${fly}.fly.dev/wake`,
        instance: process.env.FLY_MACHINE_ID ?? null,
        token,
      }
    : {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wake`,
        instance: null,
        token,
      };
  const value = JSON.stringify(registration);
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  try {
    await db.query(
      `INSERT INTO ctf.settings(key,value,updated_by,updated_at) VALUES($1,$2,NULL,now())
       ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_by=NULL,updated_at=now()`,
      [WAKE_KEY, value],
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    // Closes the server and removes this worker's row, leaving another worker's row alone. A
    // drained worker retries the delete, because the drain script waits on the row.
    async stop(retry = false) {
      await close();
      for (;;) {
        try {
          await db.query("DELETE FROM ctf.settings WHERE key=$1 AND value=$2", [WAKE_KEY, value]);
          return;
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "worker.wake.unregister.failed",
              error: error instanceof Error ? error.name : "error",
            }),
          );
          if (!retry) return;
          await sleepFor(UNREGISTER_RETRY_MS);
        }
      }
    },
  };
}
