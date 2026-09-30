import { Pool } from "pg";

const globals = globalThis as typeof globalThis & { ctfPool?: Pool };
const connection = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const connectionURL = connection ? new URL(connection) : undefined;
if (connectionURL) connectionURL.searchParams.set("sslmode", "verify-full");
export const db =
  globals.ctfPool ??
  new Pool({
    connectionString: connectionURL?.toString(),
    options: "-c search_path=ctf,public",
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 20_000,
  });
if (process.env.NODE_ENV !== "production") globals.ctfPool = db;
