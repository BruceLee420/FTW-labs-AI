/** Append-only audit trail helper. Every state change goes through here. */
import type { Repositories } from "../repositories/interfaces.ts";
import type { AuditEvent } from "../types/entities.ts";
import { newId } from "../utils/ids.ts";

export function recordAudit(
  repos: Repositories,
  now: () => string,
  entityType: AuditEvent["entityType"],
  entityId: string,
  event: string,
  detail: Record<string, unknown> = {},
  actor = "user",
): AuditEvent {
  return repos.audit.insert({ id: newId(), entityType, entityId, event, detail, actor, createdAt: now() });
}
