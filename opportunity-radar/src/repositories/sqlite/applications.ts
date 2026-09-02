/**
 * SQLite ApplicationRepository — at most one application per opportunity
 * (UNIQUE opportunity_id). Why: the approval/applied/follow-up state machine
 * hangs off this row; drafts and follow-up tasks reference it.
 */
import type { Db } from "../../db/client.ts";
import type { Application } from "../../types/entities.ts";
import type { ApplicationRepository } from "../interfaces.ts";
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

const c = defineColumns<Application>();

export const APPLICATIONS: TableSpec<Application> = {
  name: "applications",
  columns: [
    c.text("id"), c.text("opportunityId"), c.text("resumeId"), c.text("status"), c.number("currentDraftVersion"),
    c.text("approvedAt"), c.number("approvedDraftVersion"), c.text("appliedAt"), c.text("confirmationReference"),
    c.text("followUpDueAt"), c.text("followUpSentAt"), c.text("notes"), c.text("createdAt"), c.text("updatedAt"),
  ],
};

export function createApplicationRepository(db: Db, now: () => string): ApplicationRepository {
  const findById = (id: string): Application | null => selectOne(db, APPLICATIONS, "WHERE id = ?", [id]);
  return {
    insert(application) {
      insertEntity(db, APPLICATIONS, application);
      return findById(application.id) ?? application;
    },
    update(id, patch) {
      const assignments = patchAssignments(patch, APPLICATIONS, ["id", "updatedAt"]);
      assignments.sets.push("updated_at = ?");
      assignments.params.push(now());
      return updateById(db, APPLICATIONS, id, assignments) ? findById(id) : null;
    },
    findById,
    findByOpportunity(opportunityId) {
      return selectOne(db, APPLICATIONS, "WHERE opportunity_id = ?", [opportunityId]);
    },
    listAll() {
      return selectMany(db, APPLICATIONS, "ORDER BY created_at DESC, id ASC", []);
    },
    deleteAll() {
      return deleteAllRows(db, APPLICATIONS.name);
    },
  };
}
