/**
 * SQLite SettingsRepository — a key/value store of JSON-encoded values for
 * user preferences that are not environment configuration (e.g. last sync
 * time, UI defaults). Values round-trip through JSON so any serialisable
 * shape works; unreadable rows read back as null rather than throwing.
 */
import type { Db } from "../../db/client.ts";
import type { SettingsRepository } from "../interfaces.ts";
import { parseJson } from "./rows.ts";

export function createSettingsRepository(db: Db, now: () => string): SettingsRepository {
  return {
    get<T>(key: string): T | null {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
        | { value_json: unknown }
        | undefined;
      return row ? parseJson<T | null>(row.value_json, () => null) : null;
    },
    set<T>(key: string, value: T): void {
      const encoded = value === undefined ? "null" : JSON.stringify(value);
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(key, encoded, now());
    },
    all(): Record<string, unknown> {
      const rows = db.prepare("SELECT key, value_json FROM settings ORDER BY key ASC").all() as {
        key: string;
        value_json: unknown;
      }[];
      const out: Record<string, unknown> = {};
      for (const row of rows) out[row.key] = parseJson<unknown>(row.value_json, () => null);
      return out;
    },
  };
}
