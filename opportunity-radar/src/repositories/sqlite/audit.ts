/**
 * SQLite AuditRepository — append-only trail of what happened to each entity
 * and who did it. Why: every status change, approval and AI call is recorded
 * so the user can always answer "why is this here?". Newest first; ties on
 * created_at break by insertion order (rowid).
 */
import type { Db } from "../../db/client.ts";
import type { AuditEvent } from "../../types/entities.ts";
import type { AuditRepository } from "../interfaces.ts";
import { defineColumns, deleteAllRows, insertEntity, selectMany, selectOne, type TableSpec } from "./rows.ts";

const c = defineColumns<AuditEvent>();

export const AUDIT_EVENTS: TableSpec<AuditEvent> = {
  name: "audit_events",
  columns: [
    c.text("id"), c.text("entityType"), c.text("entityId"), c.text("event"), c.record("detail", "detail_json"),
    c.text("actor"), c.text("createdAt"),
  ],
};

const DEFAULT_LIMIT = 200;
const NEWEST_FIRST = "ORDER BY created_at DESC, rowid DESC";

function cap(limit: number | undefined, fallback: number): number {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createAuditRepository(db: Db): AuditRepository {
  return {
    insert(event) {
      insertEntity(db, AUDIT_EVENTS, event);
      return selectOne(db, AUDIT_EVENTS, "WHERE id = ?", [event.id]) ?? event;
    },
    listForEntity(entityType, entityId, limit) {
      return selectMany(
        db,
        AUDIT_EVENTS,
        `WHERE entity_type = ? AND entity_id = ? ${NEWEST_FIRST} LIMIT ?`,
        [entityType, entityId, cap(limit, DEFAULT_LIMIT)],
      );
    },
    listRecent(limit) {
      return selectMany(db, AUDIT_EVENTS, `${NEWEST_FIRST} LIMIT ?`, [cap(limit, DEFAULT_LIMIT)]);
    },
    deleteAll() {
      return deleteAllRows(db, AUDIT_EVENTS.name);
    },
  };
}
