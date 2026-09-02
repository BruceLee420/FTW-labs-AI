/**
 * SQLite FollowUpRepository — reminders the user acts on by hand.
 * Why: nothing in this module sends anything; a follow-up task only surfaces
 * a due date and an optional draft so the person can decide what to do.
 */
import type { Db } from "../../db/client.ts";
import type { FollowUpTask } from "../../types/entities.ts";
import type { FollowUpRepository } from "../interfaces.ts";
import {
  defineColumns,
  deleteAllRows,
  insertEntity,
  patchAssignments,
  selectMany,
  selectOne,
  updateById,
  type TableSpec,
} from "./rows.ts";

const c = defineColumns<FollowUpTask>();

export const FOLLOW_UP_TASKS: TableSpec<FollowUpTask> = {
  name: "follow_up_tasks",
  columns: [
    c.text("id"), c.text("opportunityId"), c.text("applicationId"), c.text("dueAt"), c.text("status"), c.text("note"),
    c.text("draftId"), c.text("completedAt"), c.text("createdAt"), c.text("updatedAt"),
  ],
};

const BY_DUE = "ORDER BY due_at ASC, id ASC";

export function createFollowUpRepository(db: Db, now: () => string): FollowUpRepository {
  const findById = (id: string): FollowUpTask | null => selectOne(db, FOLLOW_UP_TASKS, "WHERE id = ?", [id]);
  return {
    insert(task) {
      insertEntity(db, FOLLOW_UP_TASKS, task);
      return findById(task.id) ?? task;
    },
    update(id, patch) {
      const assignments = patchAssignments(patch, FOLLOW_UP_TASKS, ["id", "updatedAt"]);
      assignments.sets.push("updated_at = ?");
      assignments.params.push(now());
      return updateById(db, FOLLOW_UP_TASKS, id, assignments) ? findById(id) : null;
    },
    findById,
    listByOpportunity(opportunityId) {
      return selectMany(db, FOLLOW_UP_TASKS, `WHERE opportunity_id = ? ${BY_DUE}`, [opportunityId]);
    },
    listPending() {
      return selectMany(db, FOLLOW_UP_TASKS, `WHERE status = ? ${BY_DUE}`, ["PENDING"]);
    },
    listDue(nowIso) {
      return selectMany(db, FOLLOW_UP_TASKS, `WHERE status = ? AND due_at <= ? ${BY_DUE}`, ["PENDING", nowIso]);
    },
    listAll() {
      return selectMany(db, FOLLOW_UP_TASKS, BY_DUE, []);
    },
    deleteAll() {
      return deleteAllRows(db, FOLLOW_UP_TASKS.name);
    },
  };
}
