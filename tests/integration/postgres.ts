import type { Pool } from "pg";

export async function closePool(pool: Pool) {
  // pg-pool resolves end() before its socket-close callbacks emit remove.
  // Wait for every client before a test drops the disposable database.
  let remaining = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (!remaining) resolve();
    else
      pool.on("remove", () => {
        if (--remaining === 0) resolve();
      });
  });
  await pool.end();
  await closed;
}
