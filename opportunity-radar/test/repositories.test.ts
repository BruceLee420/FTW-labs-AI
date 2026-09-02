/**
 * SQLite repository tests — every filter, sort, duplicate key and counter
 * against an in-memory database. Fixtures are synthetic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildApplication,
  buildAuditEvent,
  buildDraft,
  buildEvaluation,
  buildFollowUp,
  buildOpportunity,
  buildResume,
  buildSource,
  buildSyncRun,
  createTestDb,
  createTestRepos,
} from "./helpers/db.ts";
import { escapeLike, resolveSortColumn } from "../src/repositories/sqlite/opportunities.ts";
import { fromSql, snakeCase, toSql } from "../src/repositories/sqlite/rows.ts";
import { OpportunityListQuerySchema, type OpportunityListQuery } from "../src/schemas/opportunity.ts";
import { HttpError } from "../src/utils/errors.ts";
import { normalizeCompanyName, normalizeTitle } from "../src/utils/text.ts";
import type { Opportunity } from "../src/types/entities.ts";
import type { DuplicateProbe } from "../src/repositories/interfaces.ts";

const BASE_QUERY: OpportunityListQuery = OpportunityListQuerySchema.parse({});
const query = (overrides: Partial<OpportunityListQuery> = {}): OpportunityListQuery => ({ ...BASE_QUERY, ...overrides });
const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);
const fixedClock = (iso: string) => () => iso;

describe("rows helpers", () => {
  it("maps names and coerces values node:sqlite cannot bind", () => {
    assert.equal(snakeCase("companyNameNormalized"), "company_name_normalized");
    assert.equal(toSql(true, "bool"), 1);
    assert.equal(toSql(false, "bool"), 0);
    assert.equal(toSql(undefined, "text"), null);
    assert.equal(toSql(["a"], "json"), '["a"]');
    assert.equal(toSql(Number.NaN, "number"), null);
    assert.deepEqual(fromSql("not json", { kind: "json", fallback: () => [] }), []);
    assert.deepEqual(fromSql(null, { kind: "json", fallback: () => null }), null);
    assert.equal(fromSql(1, { kind: "bool", fallback: () => false }), true);
    assert.equal(fromSql(0, { kind: "bool", fallback: () => false }), false);
  });
});

describe("OpportunityRepository", () => {
  it("inserts, reads back every field and computes the normalized columns", () => {
    const db = createTestDb();
    const repos = createTestRepos(db);
    const opp = buildOpportunity({
      companyName: "Acme, Inc.",
      title: "Senior Engineer (Remote)",
      eligibleCountries: ["US", "CA"],
      scamSignals: [{ code: "REQUESTS_PAYMENT", kind: "risk", weight: 40, message: "Asks for a fee", evidence: "fee" }],
      compensation: { text: "$100k", min: 100000, max: 120000, currency: "USD", period: "YEAR" },
      relevanceScore: 77,
      legitimacyScore: 55,
    });
    assert.deepEqual(repos.opportunities.insert(opp), opp);
    assert.deepEqual(repos.opportunities.findById(opp.id), opp);
    assert.equal(repos.opportunities.findById("missing"), null);
    const raw = db
      .prepare("SELECT company_name_normalized AS c, title_normalized AS t FROM opportunities WHERE id = ?")
      .get(opp.id) as { c: string; t: string };
    assert.equal(raw.c, normalizeCompanyName("Acme, Inc."));
    assert.equal(raw.t, normalizeTitle("Senior Engineer (Remote)"));
    assert.equal(repos.opportunities.listAll().length, 1);
  });

  it("falls back to empty values when a JSON column is corrupt", () => {
    const db = createTestDb();
    const repos = createTestRepos(db);
    const opp = repos.opportunities.insert(buildOpportunity());
    db.prepare("UPDATE opportunities SET eligible_countries = ? WHERE id = ?").run("{not json", opp.id);
    assert.deepEqual(repos.opportunities.findById(opp.id)?.eligibleCountries, []);
  });

  it("update touches only present fields, stamps updated_at and keeps normalized columns in sync", () => {
    const db = createTestDb();
    const repos = createTestRepos(db, fixedClock("2026-09-02T00:00:00.000Z"));
    const opp = repos.opportunities.insert(buildOpportunity({ notes: "keep me", title: "Engineer" }));
    const updated = repos.opportunities.update(opp.id, { title: "Staff Engineer", status: "VERIFIED", notes: undefined });
    assert.ok(updated);
    assert.equal(updated.title, "Staff Engineer");
    assert.equal(updated.status, "VERIFIED");
    assert.equal(updated.notes, "keep me");
    assert.equal(updated.createdAt, opp.createdAt);
    assert.equal(updated.updatedAt, "2026-09-02T00:00:00.000Z");
    const raw = () =>
      db.prepare("SELECT company_name_normalized AS c, title_normalized AS t FROM opportunities WHERE id = ?").get(opp.id) as {
        c: string;
        t: string;
      };
    assert.equal(raw().t, normalizeTitle("Staff Engineer"));
    repos.opportunities.update(opp.id, { companyName: "Widgets LLC" });
    assert.equal(raw().c, normalizeCompanyName("Widgets LLC"));
    assert.equal(repos.opportunities.update("missing", { notes: "x" }), null);
    assert.equal(repos.opportunities.update(opp.id, {})?.updatedAt, "2026-09-02T00:00:00.000Z");
  });

  const seedListFixtures = () => {
    const repos = createTestRepos();
    const a = repos.opportunities.insert(
      buildOpportunity({
        status: "DISCOVERED", sourceType: "JOB_BOARD", sourceName: "board-a", workMode: "REMOTE",
        geographicEligibility: "GLOBAL", verificationStatus: "UNVERIFIED", legitimacyScore: 40, relevanceScore: 30,
        scamRiskScore: 60, discoveredAt: "2026-08-01T00:00:00.000Z", companyName: "Alpha Widgets",
        title: "Data Engineer", normalizedDescription: "Builds 100% pipelines under score",
      }),
    );
    const b = repos.opportunities.insert(
      buildOpportunity({
        status: "VERIFIED", sourceType: "OFFICIAL_ATS", sourceName: "greenhouse:beta", workMode: "HYBRID",
        geographicEligibility: "US_ONLY", verificationStatus: "LIKELY_LEGIT", legitimacyScore: 85, relevanceScore: 70,
        scamRiskScore: 10, discoveredAt: "2026-08-15T00:00:00.000Z", companyName: "Beta Labs",
        title: "Backend Engineer", normalizedDescription: "Go services for 1000 users",
      }),
    );
    const c = repos.opportunities.insert(
      buildOpportunity({
        status: "APPLIED", sourceType: "MANUAL_URL", sourceName: "manual", workMode: "ONSITE",
        geographicEligibility: "UNKNOWN", verificationStatus: "VERIFIED_OFFICIAL_SOURCE", legitimacyScore: 95,
        relevanceScore: 90, scamRiskScore: 5, discoveredAt: "2026-09-01T00:00:00.000Z", companyName: "Gamma Co",
        title: "Product Manager", normalizedDescription: "Roadmaps under_score",
      }),
    );
    const d = repos.opportunities.insert(
      buildOpportunity({
        status: "REJECTED", sourceType: "RSS", sourceName: "rss:feed", workMode: "REMOTE",
        geographicEligibility: "COUNTRY_RESTRICTED", verificationStatus: "HIGH_RISK", discoveredAt: "2026-07-01T00:00:00.000Z",
        companyName: "Delta Group", title: "Sales Rep", normalizedDescription: "Pay a fee to start",
      }),
    );
    return { repos, a, b, c, d };
  };

  it("applies every list filter", () => {
    const { repos, a, b, c, d } = seedListFixtures();
    const run = (q: Partial<OpportunityListQuery>) => ids(repos.opportunities.list(query(q)).items);
    assert.deepEqual(run({}), [c.id, b.id, a.id, d.id]);
    assert.deepEqual(run({ status: ["VERIFIED", "APPLIED"] }), [c.id, b.id]);
    assert.deepEqual(run({ sourceType: ["OFFICIAL_ATS"] }), [b.id]);
    assert.deepEqual(run({ sourceName: "manual" }), [c.id]);
    assert.deepEqual(run({ workMode: ["REMOTE"] }), [a.id, d.id]);
    assert.deepEqual(run({ geographicEligibility: ["US_ONLY", "UNKNOWN"] }), [c.id, b.id]);
    assert.deepEqual(run({ verificationStatus: ["HIGH_RISK"] }), [d.id]);
    assert.deepEqual(run({ minLegitimacy: 80 }), [c.id, b.id]);
    assert.deepEqual(run({ minRelevance: 50 }), [c.id, b.id]);
    assert.deepEqual(run({ maxScamRisk: 20 }), [c.id, b.id]);
    assert.deepEqual(run({ discoveredAfter: "2026-08-15T00:00:00.000Z" }), [c.id, b.id]);
    assert.deepEqual(run({ discoveredBefore: "2026-08-01T00:00:00.000Z" }), [a.id, d.id]);
    assert.deepEqual(run({ status: ["DISCOVERED", "REJECTED"], workMode: ["REMOTE"], minLegitimacy: 10 }), [a.id]);
    assert.deepEqual(run({ status: [] }), [c.id, b.id, a.id, d.id]);
  });

  it("search matches company, title, description and source name with wildcards escaped", () => {
    const { repos, a, b, c } = seedListFixtures();
    const run = (search: string) => ids(repos.opportunities.list(query({ search })).items);
    assert.deepEqual(run("engineer"), [b.id, a.id]);
    assert.deepEqual(run("ALPHA"), [a.id]);
    assert.deepEqual(run("greenhouse"), [b.id]);
    assert.deepEqual(run("100%"), [a.id], "unescaped % would also match the '1000 users' row");
    assert.deepEqual(run("under_score"), [c.id], "unescaped _ would also match 'under score'");
    assert.deepEqual(run("nothing-here"), []);
    assert.equal(escapeLike("100%_\\"), "100\\%\\_\\\\");
  });

  it("sorts through the allow-list and falls back to discovered_at for unknown keys", () => {
    const { repos, a, b, c, d } = seedListFixtures();
    const run = (q: Partial<OpportunityListQuery>) => ids(repos.opportunities.list(query(q)).items);
    assert.deepEqual(run({ order: "asc" }), [d.id, a.id, b.id, c.id]);
    assert.deepEqual(run({ sort: "companyName", order: "asc" }), [a.id, b.id, d.id, c.id]);
    assert.deepEqual(run({ sort: "title", order: "desc" }), [d.id, c.id, a.id, b.id]);
    assert.deepEqual(run({ sort: "legitimacyScore", order: "desc" }), [c.id, b.id, a.id, d.id]);
    assert.deepEqual(run({ sort: "legitimacyScore", order: "asc" }), [a.id, b.id, c.id, d.id], "NULLs last");
    const hostile = ["constructor", "__proto__", "id; DROP TABLE opportunities", ""] as unknown as OpportunityListQuery["sort"][];
    for (const sort of hostile) {
      assert.deepEqual(run({ sort }), [c.id, b.id, a.id, d.id]);
      assert.equal(resolveSortColumn(sort), "discovered_at");
    }
    assert.equal(resolveSortColumn(undefined), "discovered_at");
    assert.equal(resolveSortColumn("companyName"), "company_name COLLATE NOCASE");
    assert.equal(repos.opportunities.listAll().length, 4, "table survived the hostile sort keys");
  });

  it("paginates and reports the filtered total ignoring limit/offset", () => {
    const { repos, a, b } = seedListFixtures();
    const page = repos.opportunities.list(query({ limit: 2, offset: 1 }));
    assert.deepEqual(ids(page.items), [b.id, a.id]);
    assert.equal(page.total, 4);
    const filtered = repos.opportunities.list(query({ workMode: ["REMOTE"], limit: 1 }));
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.total, 2);
    assert.deepEqual(repos.opportunities.list(query({ offset: 10 })), { items: [], total: 4 });
  });

  it("finds duplicate candidates by each key, distinct and newest first", () => {
    const repos = createTestRepos();
    const x = repos.opportunities.insert(
      buildOpportunity({
        canonicalUrl: "https://jobs.example.com/1", sourceName: "greenhouse:acme", externalId: "ext-1",
        companyName: "Acme Inc", title: "Platform Engineer", descriptionHash: "hash-x", createdAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    const y = repos.opportunities.insert(
      buildOpportunity({ canonicalUrl: "https://jobs.example.com/1", companyName: "Other", title: "Other", createdAt: "2026-09-02T00:00:00.000Z" }),
    );
    repos.opportunities.insert(buildOpportunity({ companyName: "Unrelated", title: "Unrelated" }));
    repos.opportunities.insert(buildOpportunity({ companyName: "Null Url One", title: "T1" }));
    repos.opportunities.insert(buildOpportunity({ companyName: "Null Url Two", title: "T2" }));
    const probe: DuplicateProbe = {
      canonicalUrl: null, sourceName: "nowhere", externalId: null, companyNameNormalized: "zzz", titleNormalized: "zzz",
      workMode: "REMOTE", locationText: null, descriptionHash: "no-such-hash",
    };
    const find = (p: Partial<DuplicateProbe>) => ids(repos.opportunities.findDuplicateCandidates({ ...probe, ...p }));
    assert.deepEqual(find({}), [], "null canonical/external never match rows whose keys are null");
    assert.deepEqual(find({ canonicalUrl: "https://jobs.example.com/1" }), [y.id, x.id]);
    assert.deepEqual(find({ sourceName: "greenhouse:acme", externalId: "ext-1" }), [x.id]);
    assert.deepEqual(find({ sourceName: "greenhouse:other", externalId: "ext-1" }), []);
    assert.deepEqual(
      find({ companyNameNormalized: normalizeCompanyName("ACME, Inc."), titleNormalized: normalizeTitle("Platform Engineer (Remote)") }),
      [x.id],
    );
    assert.deepEqual(find({ descriptionHash: "hash-x" }), [x.id]);
    assert.deepEqual(
      find({
        canonicalUrl: "https://jobs.example.com/1", sourceName: "greenhouse:acme", externalId: "ext-1",
        companyNameNormalized: normalizeCompanyName("Acme Inc"), titleNormalized: normalizeTitle("Platform Engineer"), descriptionHash: "hash-x",
      }),
      [y.id, x.id],
      "a row matching several keys appears once",
    );
  });

  const seedCounts = () => {
    const repos = createTestRepos();
    const add = (o: Partial<Opportunity>) => repos.opportunities.insert(buildOpportunity(o));
    const rows = {
      a: add({ status: "REVIEW_NEEDED", verificationStatus: "UNVERIFIED" }),
      b: add({ status: "DISCOVERED", verificationStatus: "NEEDS_MANUAL_REVIEW" }),
      c: add({ status: "VERIFIED", verificationStatus: "LIKELY_LEGIT", discoveredAt: "2026-08-01T00:00:00.000Z" }),
      d: add({ status: "READY_TO_APPLY", verificationStatus: "VERIFIED_OFFICIAL_SOURCE", discoveredAt: "2026-08-20T00:00:00.000Z" }),
      e: add({ status: "APPLIED", verificationStatus: "LIKELY_LEGIT", followUpDueAt: "2026-08-30T00:00:00.000Z", discoveredAt: "2026-08-10T00:00:00.000Z" }),
      f: add({ status: "FOLLOW_UP_DUE", followUpDueAt: "2026-09-01T00:00:00.000Z" }),
      g: add({ status: "APPLIED", followUpDueAt: "2026-09-05T00:00:00.000Z" }),
      h: add({ status: "INTERVIEWING", followUpDueAt: "2026-08-01T00:00:00.000Z" }),
      r: add({ status: "REJECTED", verificationStatus: "LIKELY_LEGIT", discoveredAt: "2026-09-01T00:00:00.000Z" }),
    };
    return { repos, ...rows };
  };

  it("counts() reports totals, breakdowns and dashboard counters", () => {
    const empty = createTestRepos().opportunities.counts("2026-09-01T00:00:00.000Z");
    assert.equal(empty.total, 0);
    assert.equal(empty.byStatus.DISCOVERED, 0);
    assert.equal(empty.followUpsDue, 0);
    const { repos } = seedCounts();
    const counts = repos.opportunities.counts("2026-09-01T00:00:00.000Z");
    assert.equal(counts.total, 9);
    assert.equal(counts.byStatus.APPLIED, 2);
    assert.equal(counts.byStatus.REVIEW_NEEDED, 1);
    assert.equal(counts.byStatus.OFFER, 0);
    assert.equal(counts.byVerification.LIKELY_LEGIT, 3);
    assert.equal(counts.byVerification.UNVERIFIED, 4);
    assert.equal(counts.needsReview, 2);
    assert.equal(counts.verified, 4);
    assert.equal(counts.followUpsDue, 2);
    assert.equal(counts.readyToApply, 2);
  });

  it("lists follow-ups due (ordered) and recent verified (excluding closed states)", () => {
    const { repos, c, d, e, f } = seedCounts();
    assert.deepEqual(ids(repos.opportunities.listFollowUpsDue("2026-09-01T00:00:00.000Z")), [e.id, f.id]);
    assert.deepEqual(ids(repos.opportunities.listFollowUpsDue("2026-08-01T00:00:00.000Z")), []);
    assert.deepEqual(ids(repos.opportunities.listRecentVerified(2)), [d.id, e.id]);
    assert.deepEqual(ids(repos.opportunities.listRecentVerified(10)), [d.id, e.id, c.id]);
  });

  it("delete and deleteAll report what was removed and cascade to sources", () => {
    const repos = createTestRepos();
    const one = repos.opportunities.insert(buildOpportunity());
    const two = repos.opportunities.insert(buildOpportunity());
    repos.sources.insert(buildSource(one.id));
    assert.equal(repos.opportunities.delete(one.id), true);
    assert.equal(repos.opportunities.delete(one.id), false);
    assert.deepEqual(repos.sources.listByOpportunity(one.id), []);
    assert.equal(repos.opportunities.deleteAll(), 1);
    assert.equal(repos.opportunities.findById(two.id), null);
  });
});

describe("OpportunitySourceRepository and EvaluationRepository", () => {
  it("lists sightings newest first per opportunity", () => {
    const repos = createTestRepos();
    const opp = repos.opportunities.insert(buildOpportunity());
    const older = repos.sources.insert(buildSource(opp.id, { seenAt: "2026-08-01T00:00:00.000Z", externalId: "e1" }));
    const newer = repos.sources.insert(buildSource(opp.id, { seenAt: "2026-08-02T00:00:00.000Z", descriptionHash: "h" }));
    assert.deepEqual(repos.sources.listByOpportunity(opp.id), [newer, older]);
    assert.deepEqual(repos.sources.listByOpportunity("other"), []);
  });

  it("keeps evaluation history and returns the latest", () => {
    const repos = createTestRepos();
    const opp = repos.opportunities.insert(buildOpportunity());
    const first = repos.evaluations.insert(buildEvaluation(opp.id, { createdAt: "2026-08-01T00:00:00.000Z" }));
    const second = repos.evaluations.insert(
      buildEvaluation(opp.id, {
        createdAt: "2026-08-02T00:00:00.000Z", provider: "ollama", model: "llama3.1", aiStatus: "OK",
        ai: {
          legitimacyScore: 80, scamRiskScore: 10, relevanceScore: 70, remoteEligibilityScore: 90, bestResumeId: "r1",
          rationale: "synthetic", evidence: [{ claim: "c", reference: "r" }], riskSignals: [], missingInformation: [],
          suggestedNextAction: "apply", confidence: "high",
        },
        candidateResumeIds: ["r1", "r2"], recommendedResumeId: "r1", matchRationale: "fits",
      }),
    );
    assert.deepEqual(repos.evaluations.latestForOpportunity(opp.id), second);
    assert.deepEqual(repos.evaluations.listForOpportunity(opp.id), [second, first]);
    assert.equal(repos.evaluations.latestForOpportunity("none"), null);
    assert.equal(first.ai, null);
  });
});

describe("ResumeRepository", () => {
  it("upserts by filename, preserving the user's edits and replacing extraction data", () => {
    const repos = createTestRepos(createTestDb(), fixedClock("2026-09-02T00:00:00.000Z"));
    const original = repos.resumes.upsertByFilename(buildResume());
    assert.deepEqual(repos.resumes.findByFilename(original.filename), original);
    const edited = repos.resumes.update(original.id, { label: "My label", targetRoles: ["CTO"], isActive: false });
    assert.equal(edited?.updatedAt, "2026-09-02T00:00:00.000Z");
    const reindexed = repos.resumes.upsertByFilename(
      buildResume({
        id: "different-id", label: "Auto label", targetRoles: ["auto"], isActive: true, createdAt: "2026-09-03T00:00:00.000Z",
        extractedText: "new text", contentHash: "hash-2", skills: ["Go"], extractionQuality: 90, fileSize: 999,
        lastIndexedAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
      }),
    );
    assert.equal(reindexed.id, original.id);
    assert.equal(reindexed.label, "My label");
    assert.deepEqual(reindexed.targetRoles, ["CTO"]);
    assert.equal(reindexed.isActive, false);
    assert.equal(reindexed.createdAt, original.createdAt);
    assert.equal(reindexed.extractedText, "new text");
    assert.equal(reindexed.contentHash, "hash-2");
    assert.deepEqual(reindexed.skills, ["Go"]);
    assert.equal(reindexed.fileSize, 999);
    assert.equal(reindexed.updatedAt, "2026-09-03T00:00:00.000Z");
    assert.equal(repos.resumes.findById("different-id"), null);
    assert.equal(repos.resumes.update("missing", { label: "x" }), null);
  });

  it("lists, filters active profiles and deletes", () => {
    const repos = createTestRepos();
    const active = repos.resumes.upsertByFilename(buildResume({ filename: "a.pdf" }));
    repos.resumes.upsertByFilename(buildResume({ filename: "b.txt", format: "txt", isActive: false }));
    assert.deepEqual(ids(repos.resumes.listActive()), [active.id]);
    const all = repos.resumes.listAll();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.extractedText, active.extractedText);
    assert.equal(repos.resumes.delete(active.id), true);
    assert.equal(repos.resumes.delete(active.id), false);
    assert.equal(repos.resumes.deleteAll(), 1);
  });
});

describe("ApplicationRepository and DraftRepository", () => {
  it("stores one application per opportunity and updates it", () => {
    const repos = createTestRepos(createTestDb(), fixedClock("2026-09-02T00:00:00.000Z"));
    const opp = repos.opportunities.insert(buildOpportunity());
    const app = repos.applications.insert(buildApplication(opp.id));
    assert.deepEqual(repos.applications.findByOpportunity(opp.id), app);
    const updated = repos.applications.update(app.id, { status: "SUBMITTED", appliedAt: "2026-09-02T00:00:00.000Z", currentDraftVersion: 2 });
    assert.equal(updated?.status, "SUBMITTED");
    assert.equal(updated?.currentDraftVersion, 2);
    assert.equal(updated?.updatedAt, "2026-09-02T00:00:00.000Z");
    assert.deepEqual(ids(repos.applications.listAll()), [app.id]);
    assert.equal(repos.applications.update("missing", {}), null);
    assert.equal(repos.applications.deleteAll(), 1);
    assert.equal(repos.applications.findById(app.id), null);
  });

  it("versions drafts per kind and rejects duplicate versions with a 409", () => {
    const repos = createTestRepos();
    const opp = repos.opportunities.insert(buildOpportunity());
    const app = repos.applications.insert(buildApplication(opp.id));
    const v1 = repos.drafts.insert(buildDraft(app.id, opp.id, { version: 1 }));
    const v2 = repos.drafts.insert(buildDraft(app.id, opp.id, { version: 2, generatedBy: "user", groundingWarnings: ["w"] }));
    const email = repos.drafts.insert(
      buildDraft(app.id, opp.id, { kind: "FOLLOW_UP_EMAIL", version: 1, content: { subject: "s", body: "b", evidence: [] } }),
    );
    assert.deepEqual(repos.drafts.latest(app.id, "APPLICATION_PACKAGE"), v2);
    assert.deepEqual(repos.drafts.latest(app.id, "FOLLOW_UP_EMAIL"), email);
    assert.deepEqual(repos.drafts.findVersion(app.id, "APPLICATION_PACKAGE", 1), v1);
    assert.equal(repos.drafts.findVersion(app.id, "APPLICATION_PACKAGE", 9), null);
    assert.throws(
      () => repos.drafts.insert(buildDraft(app.id, opp.id, { version: 2 })),
      (err: unknown) => err instanceof HttpError && err.status === 409,
    );
    assert.equal(repos.drafts.listByApplication(app.id).length, 3);
    assert.equal(repos.drafts.update(v1.id, { editedAt: "2026-09-02T00:00:00.000Z" })?.editedAt, "2026-09-02T00:00:00.000Z");
    assert.equal(repos.drafts.listAll().length, 3);
    assert.equal(repos.drafts.deleteAll(), 3);
  });
});

describe("FollowUpRepository", () => {
  it("lists pending and due tasks in due order", () => {
    const repos = createTestRepos(createTestDb(), fixedClock("2026-09-02T00:00:00.000Z"));
    const opp = repos.opportunities.insert(buildOpportunity());
    const t2 = repos.followUps.insert(buildFollowUp(opp.id, { dueAt: "2026-09-05T00:00:00.000Z" }));
    const t1 = repos.followUps.insert(buildFollowUp(opp.id, { dueAt: "2026-08-30T00:00:00.000Z" }));
    repos.followUps.insert(buildFollowUp(opp.id, { dueAt: "2026-08-01T00:00:00.000Z", status: "DONE" }));
    repos.followUps.insert(buildFollowUp(opp.id, { dueAt: "2026-08-01T00:00:00.000Z", status: "CANCELLED" }));
    assert.deepEqual(ids(repos.followUps.listDue("2026-09-01T00:00:00.000Z")), [t1.id]);
    assert.deepEqual(ids(repos.followUps.listDue("2026-09-05T00:00:00.000Z")), [t1.id, t2.id]);
    assert.deepEqual(ids(repos.followUps.listPending()), [t1.id, t2.id]);
    assert.equal(repos.followUps.listByOpportunity(opp.id).length, 4);
    const done = repos.followUps.update(t1.id, { status: "DONE", completedAt: "2026-09-02T00:00:00.000Z" });
    assert.equal(done?.status, "DONE");
    assert.equal(done?.updatedAt, "2026-09-02T00:00:00.000Z");
    assert.deepEqual(ids(repos.followUps.listPending()), [t2.id]);
    assert.equal(repos.followUps.findById("missing"), null);
    assert.equal(repos.followUps.deleteAll(), 4);
    assert.deepEqual(repos.followUps.listAll(), []);
  });
});

describe("SyncRunRepository, AuditRepository and SettingsRepository", () => {
  it("records sync runs and lists the most recent", () => {
    const repos = createTestRepos();
    const r1 = repos.syncRuns.insert(buildSyncRun({ startedAt: "2026-09-01T00:00:00.000Z" }));
    const r2 = repos.syncRuns.insert(buildSyncRun({ startedAt: "2026-09-02T00:00:00.000Z" }));
    const r3 = repos.syncRuns.insert(buildSyncRun({ startedAt: "2026-09-03T00:00:00.000Z" }));
    assert.deepEqual(ids(repos.syncRuns.listRecent(2)), [r3.id, r2.id]);
    const finished = repos.syncRuns.update(r1.id, { status: "PARTIAL", finishedAt: "2026-09-01T01:00:00.000Z", fetched: 5, errors: ["timeout"] });
    assert.deepEqual(finished, { ...r1, status: "PARTIAL", finishedAt: "2026-09-01T01:00:00.000Z", fetched: 5, errors: ["timeout"] });
    assert.equal(repos.syncRuns.update("missing", { status: "FAILED" }), null);
  });

  it("returns audit events newest first with a default limit of 200", () => {
    const repos = createTestRepos();
    for (let i = 1; i <= 205; i += 1) {
      repos.audit.insert(buildAuditEvent({ event: `e${i}`, createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z` }));
    }
    const tieA = repos.audit.insert(buildAuditEvent({ event: "tie-first", createdAt: "2027-01-01T00:00:00.000Z", detail: { n: 1 } }));
    const tieB = repos.audit.insert(buildAuditEvent({ event: "tie-second", createdAt: "2027-01-01T00:00:00.000Z", detail: { n: 2 } }));
    repos.audit.insert(buildAuditEvent({ entityId: "other", createdAt: "2028-01-01T00:00:00.000Z" }));
    const list = repos.audit.listForEntity("opportunity", "opp-1");
    assert.equal(list.length, 200);
    assert.deepEqual(list.slice(0, 2), [tieB, tieA], "same timestamp breaks by insertion order");
    assert.equal(repos.audit.listForEntity("opportunity", "opp-1", 3).length, 3);
    assert.equal(repos.audit.listRecent(1)[0]?.entityId, "other");
    assert.deepEqual(repos.audit.listForEntity("resume", "opp-1"), []);
    assert.equal(repos.audit.deleteAll(), 208);
  });

  it("round-trips JSON settings", () => {
    const repos = createTestRepos();
    assert.equal(repos.settings.get("missing"), null);
    repos.settings.set("prefs", { theme: "dark", days: 7 });
    repos.settings.set("count", 3);
    repos.settings.set("flag", false);
    repos.settings.set("nothing", null);
    assert.deepEqual(repos.settings.get("prefs"), { theme: "dark", days: 7 });
    assert.equal(repos.settings.get("count"), 3);
    assert.equal(repos.settings.get("flag"), false);
    assert.equal(repos.settings.get("nothing"), null);
    repos.settings.set("count", 4);
    assert.deepEqual(repos.settings.all(), { count: 4, flag: false, nothing: null, prefs: { theme: "dark", days: 7 } });
  });
});

describe("transaction", () => {
  it("rolls back on throw and commits on success", () => {
    const repos = createTestRepos();
    const opp = buildOpportunity();
    assert.throws(
      () =>
        repos.transaction(() => {
          repos.opportunities.insert(opp);
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(repos.opportunities.findById(opp.id), null);
    const out = repos.transaction(() => repos.opportunities.insert(opp).id);
    assert.equal(out, opp.id);
    assert.ok(repos.opportunities.findById(opp.id));
  });

  it("nests via savepoints so an inner failure does not abort the outer transaction", () => {
    const repos = createTestRepos();
    const outer = buildOpportunity();
    const inner = buildOpportunity();
    const kept = buildOpportunity();
    repos.transaction(() => {
      repos.opportunities.insert(outer);
      assert.throws(() =>
        repos.transaction(() => {
          repos.opportunities.insert(inner);
          throw new Error("inner");
        }),
      );
      repos.transaction(() => repos.opportunities.insert(kept));
    });
    assert.ok(repos.opportunities.findById(outer.id));
    assert.equal(repos.opportunities.findById(inner.id), null);
    assert.ok(repos.opportunities.findById(kept.id));
  });
});
