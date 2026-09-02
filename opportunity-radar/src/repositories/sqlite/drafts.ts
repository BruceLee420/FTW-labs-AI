/**
 * SQLite DraftRepository — versioned application packages and follow-up
 * emails. Why: drafts are immutable history; each regeneration or user edit
 * is a new version, and UNIQUE(application_id, kind, version) guarantees two
 * writers can never both claim the same version number (surfaced as a 409).
 */
import type { Db } from "../../db/client.ts";
import type { ApplicationDraft } from "../../types/entities.ts";
import type { DraftRepository } from "../interfaces.ts";
import { conflict } from "../../utils/errors.ts";
import {
  defineColumns,
  deleteAllRows,
  insertEntity,
  isUniqueViolation,
  patchAssignments,
  selectMany,
  selectOne,
  updateById,
  type TableSpec,
} from "./rows.ts";

const c = defineColumns<ApplicationDraft>();

export const APPLICATION_DRAFTS: TableSpec<ApplicationDraft> = {
  name: "application_drafts",
  columns: [
    c.text("id"), c.text("applicationId"), c.text("opportunityId"), c.text("resumeId"), c.text("kind"),
    c.number("version"), c.record("content", "content_json"), c.list("groundingWarnings"), c.text("generatedBy"),
    c.text("provider"), c.text("model"), c.text("promptVersion"), c.text("createdAt"), c.text("editedAt"),
  ],
};

export function createDraftRepository(db: Db): DraftRepository {
  const findById = (id: string): ApplicationDraft | null => selectOne(db, APPLICATION_DRAFTS, "WHERE id = ?", [id]);
  return {
    insert(draft) {
      try {
        insertEntity(db, APPLICATION_DRAFTS, draft);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw conflict("That draft version already exists.", {
            applicationId: draft.applicationId,
            kind: draft.kind,
            version: draft.version,
          });
        }
        throw err;
      }
      return findById(draft.id) ?? draft;
    },
    update(id, patch) {
      const assignments = patchAssignments(patch, APPLICATION_DRAFTS, ["id"]);
      return updateById(db, APPLICATION_DRAFTS, id, assignments) ? findById(id) : null;
    },
    findById,
    listByApplication(applicationId) {
      return selectMany(db, APPLICATION_DRAFTS, "WHERE application_id = ? ORDER BY kind ASC, version DESC", [
        applicationId,
      ]);
    },
    latest(applicationId, kind) {
      return selectOne(
        db,
        APPLICATION_DRAFTS,
        "WHERE application_id = ? AND kind = ? ORDER BY version DESC LIMIT 1",
        [applicationId, kind],
      );
    },
    findVersion(applicationId, kind, version) {
      return selectOne(db, APPLICATION_DRAFTS, "WHERE application_id = ? AND kind = ? AND version = ?", [
        applicationId,
        kind,
        version,
      ]);
    },
    listAll() {
      return selectMany(db, APPLICATION_DRAFTS, "ORDER BY created_at DESC, version DESC, id ASC", []);
    },
    deleteAll() {
      return deleteAllRows(db, APPLICATION_DRAFTS.name);
    },
  };
}
