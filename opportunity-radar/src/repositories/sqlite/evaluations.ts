/**
 * SQLite EvaluationRepository — append-only history of rule + model
 * evaluations per opportunity. Why: every evaluation is kept (never updated)
 * so the user can see how a verdict changed over time and which prompt
 * version / model produced it.
 */
import type { Db } from "../../db/client.ts";
import type { Evaluation } from "../../types/entities.ts";
import type { EvaluationRepository } from "../interfaces.ts";
import { defineColumns, insertEntity, selectMany, selectOne, type TableSpec } from "./rows.ts";

const c = defineColumns<Evaluation>();

export const EVALUATIONS: TableSpec<Evaluation> = {
  name: "evaluations",
  columns: [
    c.text("id"), c.text("opportunityId"), c.text("createdAt"), c.text("promptVersion"), c.text("provider"),
    c.text("model"), c.text("aiStatus"), c.text("aiError"),
    c.record("rules", "rules_json"), c.json("ai", "ai_json"),
    c.list("candidateResumeIds"), c.text("recommendedResumeId"), c.text("matchRationale"),
  ],
};

const NEWEST_FIRST = "WHERE opportunity_id = ? ORDER BY created_at DESC, rowid DESC";

export function createEvaluationRepository(db: Db): EvaluationRepository {
  return {
    insert(evaluation) {
      insertEntity(db, EVALUATIONS, evaluation);
      return selectOne(db, EVALUATIONS, "WHERE id = ?", [evaluation.id]) ?? evaluation;
    },
    latestForOpportunity(opportunityId) {
      return selectOne(db, EVALUATIONS, `${NEWEST_FIRST} LIMIT 1`, [opportunityId]);
    },
    listForOpportunity(opportunityId) {
      return selectMany(db, EVALUATIONS, NEWEST_FIRST, [opportunityId]);
    },
  };
}
