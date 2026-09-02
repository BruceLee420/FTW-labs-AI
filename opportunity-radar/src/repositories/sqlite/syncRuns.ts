/**
 * SQLite SyncRunRepository — one row per adapter sync, so the UI can show
 * what the last discovery pass fetched, created, skipped and failed on.
 */
import type { Db } from "../../db/client.ts";
import type { SourceSyncRun } from "../../types/entities.ts";
import type { SyncRunRepository } from "../interfaces.ts";
import { defineColumns, insertEntity, patchAssignments, selectMany, selectOne, updateById, type TableSpec } from "./rows.ts";

const c = defineColumns<SourceSyncRun>();

export const SOURCE_SYNC_RUNS: TableSpec<SourceSyncRun> = {
  name: "source_sync_runs",
  columns: [
    c.text("id"), c.text("adapterId"), c.text("sourceName"), c.text("startedAt"), c.text("finishedAt"), c.text("status"),
    c.number("fetched"), c.number("created"), c.number("duplicates"), c.list("errors"),
  ],
};

export function createSyncRunRepository(db: Db): SyncRunRepository {
  const findById = (id: string): SourceSyncRun | null => selectOne(db, SOURCE_SYNC_RUNS, "WHERE id = ?", [id]);
  return {
    insert(run) {
      insertEntity(db, SOURCE_SYNC_RUNS, run);
      return findById(run.id) ?? run;
    },
    update(id, patch) {
      const assignments = patchAssignments(patch, SOURCE_SYNC_RUNS, ["id"]);
      return updateById(db, SOURCE_SYNC_RUNS, id, assignments) ? findById(id) : null;
    },
    listRecent(limit) {
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      return selectMany(db, SOURCE_SYNC_RUNS, "ORDER BY started_at DESC, rowid DESC LIMIT ?", [cap]);
    },
  };
}
