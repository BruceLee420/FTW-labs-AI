import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.ts";
import { transaction } from "./client.ts";

/** Source layout (src/db/migrations) or bundled layout (dist/server.mjs → ../src/db/migrations). */
function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "migrations"), join(here, "..", "src", "db", "migrations"), join(here, "db", "migrations")];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

const MIGRATIONS_DIR = defaultMigrationsDir();

export interface MigrationResult {
  applied: string[];
  current: string | null;
}

/** Apply every `NNNN_name.sql` under migrations/ that has not been recorded yet. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    transaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    applied.push(file);
  }
  const current = files.length ? files[files.length - 1]! : null;
  return { applied, current };
}
