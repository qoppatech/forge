import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type Db = SQL;

export function connect(url: string): Db {
  return new SQL(url, { max: 10 });
}

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

/** Applies pending `migrations/*.sql` files in order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const applied = new Set(
    (await db`SELECT version FROM schema_migrations`).map((r: { version: string }) => r.version),
  );
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await Bun.file(join(MIGRATIONS, file)).text();
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
