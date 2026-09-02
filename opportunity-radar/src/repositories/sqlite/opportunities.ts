/**
 * SQLite OpportunityRepository.
 *
 * Why: the opportunities table is the hub of the module — list filtering,
 * duplicate probing and the dashboard counters all live here. Every query is
 * a prepared statement with positional parameters. The only dynamic SQL is
 * the combination of fixed WHERE fragments plus a sort column looked up in an
 * allow-list Map (anything unknown falls back to discovered_at); user text is
 * never placed in SQL.
 */
import type { Db } from "../../db/client.ts";
import type { Opportunity, OpportunityStatus, VerificationStatus } from "../../types/entities.ts";
import { OPPORTUNITY_STATUSES, VERIFICATION_STATUSES } from "../../types/entities.ts";
import type { OpportunityListQuery } from "../../schemas/opportunity.ts";
import type { DuplicateProbe, OpportunityCounts, OpportunityRepository } from "../interfaces.ts";
import { normalizeCompanyName, normalizeTitle } from "../../utils/text.ts";
import {
  defineColumns,
  deleteAllRows,
  deleteById,
  insertEntity,
  patchAssignments,
  placeholders,
  selectMany,
  selectOne,
  updateById,
  type SqlValue,
  type TableSpec,
} from "./rows.ts";

const c = defineColumns<Opportunity>();

export const OPPORTUNITIES: TableSpec<Opportunity> = {
  name: "opportunities",
  columns: [
    c.text("id"), c.text("sourceName"), c.text("sourceType"), c.text("sourceUrl"), c.text("canonicalUrl"),
    c.text("applicationUrl"), c.text("externalId"),
    c.text("companyName"), c.text("companyDomain"), c.text("companyWebsite"), c.text("officialCareerUrl"),
    c.text("title"), c.text("employmentType"), c.text("workMode"), c.text("locationText"),
    c.text("geographicEligibility"), c.list("eligibleCountries"), c.text("timezoneRequirements"),
    c.text("rawDescription"), c.text("normalizedDescription"), c.text("descriptionHash"),
    c.list("responsibilities"), c.list("qualifications"), c.list("requiredSkills"), c.list("preferredSkills"),
    c.record("compensation"),
    c.text("postedAt"), c.text("discoveredAt"), c.text("closesAt"),
    c.number("relevanceScore"), c.number("legitimacyScore"), c.number("scamRiskScore"), c.number("remoteEligibilityScore"),
    c.text("verificationStatus"), c.list("verificationReasons"), c.list("scamSignals"),
    c.text("status"), c.text("recommendedResumeId"), c.text("matchRationale"), c.text("nextAction"),
    c.text("followUpDueAt"), c.text("notes"),
    c.text("createdAt"), c.text("updatedAt"),
  ],
};

/** Allow-list: query sort key -> ORDER BY expression. A Map so prototype keys can never match. */
const SORT_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["discoveredAt", "discovered_at"],
  ["postedAt", "posted_at"],
  ["updatedAt", "updated_at"],
  ["relevanceScore", "relevance_score"],
  ["legitimacyScore", "legitimacy_score"],
  ["scamRiskScore", "scam_risk_score"],
  ["companyName", "company_name COLLATE NOCASE"],
  ["title", "title COLLATE NOCASE"],
  ["followUpDueAt", "follow_up_due_at"],
]);
const DEFAULT_SORT = "discovered_at";

export function resolveSortColumn(sort: unknown): string {
  return typeof sort === "string" ? (SORT_COLUMNS.get(sort) ?? DEFAULT_SORT) : DEFAULT_SORT;
}

/** Escape LIKE wildcards so a search term matches literally (used with ESCAPE '\'). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

const VERIFIED_SET: VerificationStatus[] = ["LIKELY_LEGIT", "VERIFIED_OFFICIAL_SOURCE"];
const FOLLOW_UP_SET: OpportunityStatus[] = ["APPLIED", "FOLLOW_UP_DUE"];
const READY_SET: OpportunityStatus[] = ["VERIFIED", "READY_TO_APPLY"];
const INACTIVE_SET: OpportunityStatus[] = ["REJECTED", "SKIPPED", "CLOSED"];
const FOLLOW_UP_DUE_SQL = `follow_up_due_at IS NOT NULL AND follow_up_due_at <= ? AND status IN (${placeholders(FOLLOW_UP_SET.length)})`;
const LIKE = "LIKE ? ESCAPE '\\'";

interface Where {
  sql: string;
  params: SqlValue[];
}

function buildFilters(q: OpportunityListQuery): Where {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const inList = (column: string, values: readonly string[] | undefined): void => {
    if (!values || values.length === 0) return;
    clauses.push(`${column} IN (${placeholders(values.length)})`);
    params.push(...values);
  };
  const compare = (column: string, op: ">=" | "<=" | "=", value: SqlValue | undefined): void => {
    if (value === undefined || value === "") return;
    clauses.push(`${column} ${op} ?`);
    params.push(value);
  };
  inList("status", q.status);
  inList("source_type", q.sourceType);
  inList("work_mode", q.workMode);
  inList("geographic_eligibility", q.geographicEligibility);
  inList("verification_status", q.verificationStatus);
  compare("source_name", "=", q.sourceName);
  compare("legitimacy_score", ">=", q.minLegitimacy);
  compare("relevance_score", ">=", q.minRelevance);
  compare("scam_risk_score", "<=", q.maxScamRisk);
  compare("discovered_at", ">=", q.discoveredAfter);
  compare("discovered_at", "<=", q.discoveredBefore);
  if (q.search) {
    const like = `%${escapeLike(q.search)}%`;
    clauses.push(
      `(company_name ${LIKE} OR title ${LIKE} OR normalized_description ${LIKE} OR source_name ${LIKE})`,
    );
    params.push(like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function createOpportunityRepository(db: Db, now: () => string): OpportunityRepository {
  const findById = (id: string): Opportunity | null => selectOne(db, OPPORTUNITIES, "WHERE id = ?", [id]);

  return {
    insert(opportunity) {
      insertEntity(db, OPPORTUNITIES, opportunity, {
        company_name_normalized: normalizeCompanyName(opportunity.companyName),
        title_normalized: normalizeTitle(opportunity.title),
      });
      return findById(opportunity.id) ?? opportunity;
    },

    update(id, patch) {
      const { sets, params } = patchAssignments(patch, OPPORTUNITIES, ["id", "updatedAt"]);
      if (patch.companyName !== undefined) {
        sets.push("company_name_normalized = ?");
        params.push(normalizeCompanyName(patch.companyName));
      }
      if (patch.title !== undefined) {
        sets.push("title_normalized = ?");
        params.push(normalizeTitle(patch.title));
      }
      sets.push("updated_at = ?");
      params.push(now());
      return updateById(db, OPPORTUNITIES, id, { sets, params }) ? findById(id) : null;
    },

    findById,

    list(query) {
      const where = buildFilters(query);
      const direction = query.order === "asc" ? "ASC" : "DESC";
      const orderBy = `ORDER BY ${resolveSortColumn(query.sort)} ${direction} NULLS LAST, created_at DESC, id ASC`;
      const limit = Math.max(1, Math.floor(Number(query.limit) || 100));
      const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
      const items = selectMany(db, OPPORTUNITIES, `${where.sql} ${orderBy} LIMIT ? OFFSET ?`, [
        ...where.params,
        limit,
        offset,
      ]);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM opportunities ${where.sql}`).get(...where.params) as
        | { n: number | bigint }
        | undefined;
      return { items, total: Number(count?.n ?? 0) };
    },

    listAll() {
      return selectMany(db, OPPORTUNITIES, "ORDER BY discovered_at DESC, created_at DESC, id ASC", []);
    },

    findDuplicateCandidates(probe) {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (probe.canonicalUrl) {
        clauses.push("canonical_url = ?");
        params.push(probe.canonicalUrl);
      }
      if (probe.externalId) {
        clauses.push("(source_name = ? AND external_id = ?)");
        params.push(probe.sourceName, probe.externalId);
      }
      if (probe.companyNameNormalized || probe.titleNormalized) {
        clauses.push("(company_name_normalized = ? AND title_normalized = ?)");
        params.push(probe.companyNameNormalized, probe.titleNormalized);
      }
      if (probe.descriptionHash) {
        clauses.push("description_hash = ?");
        params.push(probe.descriptionHash);
      }
      if (clauses.length === 0) return [];
      return selectMany(
        db,
        OPPORTUNITIES,
        `WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC, id ASC`,
        params,
      );
    },

    delete(id) {
      return deleteById(db, OPPORTUNITIES.name, id);
    },

    deleteAll() {
      return deleteAllRows(db, OPPORTUNITIES.name);
    },

    counts(nowIso) {
      const byStatus: Record<string, number> = Object.fromEntries(OPPORTUNITY_STATUSES.map((s) => [s, 0]));
      const byVerification: Record<string, number> = Object.fromEntries(VERIFICATION_STATUSES.map((s) => [s, 0]));
      const statusRows = db.prepare("SELECT status AS k, COUNT(*) AS n FROM opportunities GROUP BY status").all() as {
        k: string;
        n: number | bigint;
      }[];
      for (const row of statusRows) byStatus[row.k] = Number(row.n);
      const verificationRows = db
        .prepare("SELECT verification_status AS k, COUNT(*) AS n FROM opportunities GROUP BY verification_status")
        .all() as { k: string; n: number | bigint }[];
      for (const row of verificationRows) byVerification[row.k] = Number(row.n);

      const summary = db
        .prepare(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = ? OR verification_status = ? THEN 1 ELSE 0 END) AS needs_review,
             SUM(CASE WHEN verification_status IN (${placeholders(VERIFIED_SET.length)}) THEN 1 ELSE 0 END) AS verified,
             SUM(CASE WHEN ${FOLLOW_UP_DUE_SQL} THEN 1 ELSE 0 END) AS follow_ups_due,
             SUM(CASE WHEN status IN (${placeholders(READY_SET.length)}) THEN 1 ELSE 0 END) AS ready_to_apply
           FROM opportunities`,
        )
        .get("REVIEW_NEEDED", "NEEDS_MANUAL_REVIEW", ...VERIFIED_SET, nowIso, ...FOLLOW_UP_SET, ...READY_SET) as
        | Record<string, number | bigint | null>
        | undefined;
      const n = (key: string): number => Number(summary?.[key] ?? 0);
      const counts: OpportunityCounts = {
        total: n("total"),
        byStatus,
        byVerification,
        needsReview: n("needs_review"),
        verified: n("verified"),
        followUpsDue: n("follow_ups_due"),
        readyToApply: n("ready_to_apply"),
      };
      return counts;
    },

    listFollowUpsDue(nowIso) {
      return selectMany(db, OPPORTUNITIES, `WHERE ${FOLLOW_UP_DUE_SQL} ORDER BY follow_up_due_at ASC, id ASC`, [
        nowIso,
        ...FOLLOW_UP_SET,
      ]);
    },

    listRecentVerified(limit) {
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      return selectMany(
        db,
        OPPORTUNITIES,
        `WHERE verification_status IN (${placeholders(VERIFIED_SET.length)})
           AND status NOT IN (${placeholders(INACTIVE_SET.length)})
         ORDER BY discovered_at DESC, created_at DESC, id ASC LIMIT ?`,
        [...VERIFIED_SET, ...INACTIVE_SET, cap],
      );
    },
  };
}

export type { DuplicateProbe };
