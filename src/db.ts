import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Pool } = pg;
export type { Pool } from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl });
}

// Apply all migrations in filename order. Every migration is idempotent
// (IF NOT EXISTS everywhere), so running the full set on every boot is fine.
// ponytail: no applied-migrations ledger; add one when a migration stops being idempotent.
export async function migrate(pool: pg.Pool): Promise<void> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(dir, file), "utf8"));
  }
}
