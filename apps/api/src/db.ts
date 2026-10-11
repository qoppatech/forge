import { readdir } from "node:fs/promises";
import path from "node:path";

import { SQL } from "bun";

export type Db = SQL;

export function connect(url: string): Db {
  return new SQL(url, { max: 10 });
}

const MIGRATIONS = path.join(import.meta.dir, "..", "migrations");

/** Applies pending `migrations/*.sql` files in order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const versions = await db`SELECT version FROM schema_migrations`;
  const applied = new Set(versions.map((r: { version: string }) => r.version));
  const entries = await readdir(MIGRATIONS);
  const files = entries.filter((f) => f.endsWith(".sql")).toSorted();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- migrations apply one at a time, in filename order
    const text = await Bun.file(path.join(MIGRATIONS, file)).text();
    // oxlint-disable-next-line no-await-in-loop -- each migration commits before the next one is read
    await db.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
    ran.push(file);
  }
  return ran;
}

/** Drops and recreates the public schema. Test databases only. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
}

export function isUniqueViolation(error: unknown): boolean {
  return (error as { errno?: string })?.errno === "23505";
}
