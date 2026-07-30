import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Pool } = pg;
export type { Pool } from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({ connectionString: databaseUrl });
}

// Apply the single init migration. Idempotent (IF NOT EXISTS everywhere), so
// running it on every boot is fine for a walking skeleton — no migration
// framework until we have more than one migration to order.
// ponytail: single-file migration, add a migrations runner when count > a few.
export async function migrate(pool: pg.Pool): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "..", "migrations", "001_init.sql"), "utf8");
  await pool.query(sql);
}
