/**
 * SQLite ResumeRepository.
 *
 * Why: résumé profiles are re-indexed from the filesystem, but the user can
 * edit label / target roles / active flag in the UI. `upsertByFilename`
 * therefore replaces only the extraction-derived columns (text, skills,
 * summaries, hash, size, dates, status) on an existing row and preserves
 * id, label, target_roles, is_active and created_at. Extracted text is
 * returned here for server-side use only; routes must project it away.
 */
import type { Db } from "../../db/client.ts";
import type { ResumeProfile } from "../../types/entities.ts";
import type { ResumeRepository } from "../interfaces.ts";
import {
  defineColumns,
  deleteAllRows,
  deleteById,
  insertEntity,
  patchAssignments,
  selectMany,
  selectOne,
  updateById,
  type TableSpec,
} from "./rows.ts";

const c = defineColumns<ResumeProfile>();

export const RESUME_PROFILES: TableSpec<ResumeProfile> = {
  name: "resume_profiles",
  columns: [
    c.text("id"), c.text("filename"), c.text("format"), c.text("label"), c.list("targetRoles"), c.list("skills"),
    c.list("industries"), c.text("experienceSummary"), c.text("educationSummary"), c.list("verifiedFacts"),
    c.text("extractedText"), c.text("extractionStatus"), c.number("extractionQuality"), c.list("extractionNotes"),
    c.text("contentHash"), c.number("fileSize"), c.text("fileModifiedAt"), c.text("lastIndexedAt"),
    c.bool("isActive"), c.text("createdAt"), c.text("updatedAt"),
  ],
};

/** Fields the user may have edited; never overwritten by a re-index. */
const USER_OWNED_FIELDS: readonly string[] = ["id", "filename", "label", "targetRoles", "isActive", "createdAt"];

export function createResumeRepository(db: Db, now: () => string): ResumeRepository {
  const findById = (id: string): ResumeProfile | null => selectOne(db, RESUME_PROFILES, "WHERE id = ?", [id]);
  const findByFilename = (filename: string): ResumeProfile | null =>
    selectOne(db, RESUME_PROFILES, "WHERE filename = ?", [filename]);

  return {
    upsertByFilename(profile) {
      const existing = findByFilename(profile.filename);
      if (!existing) {
        insertEntity(db, RESUME_PROFILES, profile);
        return findById(profile.id) ?? profile;
      }
      const assignments = patchAssignments(profile, RESUME_PROFILES, USER_OWNED_FIELDS);
      updateById(db, RESUME_PROFILES, existing.id, assignments);
      return findById(existing.id) ?? existing;
    },
    update(id, patch) {
      const assignments = patchAssignments(patch, RESUME_PROFILES, ["id", "updatedAt"]);
      assignments.sets.push("updated_at = ?");
      assignments.params.push(now());
      return updateById(db, RESUME_PROFILES, id, assignments) ? findById(id) : null;
    },
    findById,
    findByFilename,
    listAll() {
      return selectMany(db, RESUME_PROFILES, "ORDER BY filename ASC", []);
    },
    listActive() {
      return selectMany(db, RESUME_PROFILES, "WHERE is_active = 1 ORDER BY filename ASC", []);
    },
    delete(id) {
      return deleteById(db, RESUME_PROFILES.name, id);
    },
    deleteAll() {
      return deleteAllRows(db, RESUME_PROFILES.name);
    },
  };
}
