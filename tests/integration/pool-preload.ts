// Child-process preload for scripts that only need the test database, with no provider fakes.
import { Pool } from "pg";

(globalThis as typeof globalThis & { ctfPool?: Pool }).ctfPool = new Pool({
  connectionString: process.env.CTF_INTEGRATION_DATABASE_URL,
  options: "-c search_path=ctf,public",
});
