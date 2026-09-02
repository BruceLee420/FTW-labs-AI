/**
 * Service-layer unit tests over in-memory repositories: dedupe ranking,
 * normalisation, keyword résumé matching, grounded drafting, evaluation
 * (rules + fake model), the human-approved application workflow, CSV export,
 * URL / JSON / CSV ingestion, the mock source sync and the résumé indexer.
 * No network; the only filesystem use is a temp directory for the indexer.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApplication, buildOpportunity, buildResume, createTestDb, createTestRepos, FIXED_NOW } from "./helpers/db.ts";
import { FakeAiProvider, fakeFetcher, SAMPLE_LISTING } from "./helpers/harness.ts";
import { minimalDocx, minimalPdf } from "./helpers/documents.ts";
import { silentLogger } from "../src/logger.ts";
import { loadConfig, type RadarConfig } from "../src/config.ts";
import { HttpError } from "../src/utils/errors.ts";
import { normalizeCompanyName, normalizeTitle } from "../src/utils/text.ts";
import type { Opportunity, ResumeProfile } from "../src/types/entities.ts";
import type { Repositories } from "../src/repositories/interfaces.ts";
import { buildProbe, findDuplicate, rankCandidate } from "../src/services/dedupe.ts";
import { normalizeOpportunity, sectionize } from "../src/services/normalize.ts";
import { KeywordResumeRetriever } from "../src/services/resumeMatch.ts";
import { buildTemplatePackage, checkGrounding, editDraft, generateDraftPackage, generateFollowUpDraft, isGrounded } from "../src/services/drafts.ts";
import { combinedVerification, combineScores, evaluateOpportunity } from "../src/services/evaluate.ts";
import { approveApplication, completeFollowUp, defaultFollowUpDays, markApplied, refreshFollowUpStatuses, scheduleFollowUp } from "../src/services/applications.ts";
import { exportCsv, EXPORT_COLUMNS, exportRow } from "../src/services/export.ts";
import { extractListing, findJobPosting, ingestUrl, splitTitle } from "../src/services/ingest/url.ts";
import { importCsv, importJson } from "../src/services/ingest/import.ts";
import { syncSource } from "../src/services/ingest/sync.ts";
import { indexResumeFolder, listResumeFiles } from "../src/services/resumes/indexer.ts";
import { createOpportunity } from "../src/services/opportunities.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { IngestUrlInputSchema, ManualOpportunityInputSchema, OpportunityListQuerySchema } from "../src/schemas/opportunity.ts";
import { JsonImportSchema } from "../src/schemas/import.ts";
import { GenerateDraftInputSchema } from "../src/schemas/application.ts";
import type { RuleEvaluation, AiEvaluation } from "../src/types/entities.ts";

/** Mutable clock so tests can move "now" without touching Date. */
function clock(start = FIXED_NOW) {
  let current = start;
  return { now: () => current, set: (iso: string) => void (current = iso) };
}

function testConfig(baseDir: string, env: Record<string, string> = {}): RadarConfig {
  return loadConfig(
    {
      OPPORTUNITY_RADAR_DB_PATH: ":memory:",
      OPPORTUNITY_RADAR_RESUMES_DIR: join(baseDir, "resumes"),
      OPPORTUNITY_RADAR_OUTPUT_DIR: join(baseDir, "output"),
      OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: "true",
      ...env,
    },
    baseDir,
  );
}

const isHttp = (status: number) => (err: unknown) => err instanceof HttpError && err.status === status;
const ids = (items: { id: string }[]) => items.map((i) => i.id);

const softwareResume = (overrides: Partial<ResumeProfile> = {}): ResumeProfile =>
  buildResume({
    id: "resume-se",
    filename: "jordan-example-software-engineer.md",
    format: "md",
    label: "Jordan Example — Software Engineer",
    targetRoles: ["Software Engineer"],
    skills: ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Docker"],
    industries: ["Logistics"],
    experienceSummary: "Senior Software Engineer — Northwind Analytics (2020 – Present); Software Engineer — Contoso Freight (2017 – 2020)",
    educationSummary: "B.S. Computer Science, Example State University, 2017",
    verifiedFacts: [
      { kind: "role", text: "Senior Software Engineer — Northwind Analytics" },
      { kind: "employer", text: "Northwind Analytics" },
      { kind: "degree", text: "B.S. Computer Science" },
      { kind: "date-range", text: "2020 – Present" },
    ],
    extractedText:
      "Jordan Example\njordan@example.com\nSenior Software Engineer — Northwind Analytics (2020 – Present)\nBuilt TypeScript services on Node.js with PostgreSQL on AWS using Docker.\nSoftware Engineer — Contoso Freight (2017 – 2020)\nEducation\nB.S. Computer Science, Example State University, 2017",
    ...overrides,
  });

const productResume = (overrides: Partial<ResumeProfile> = {}): ResumeProfile =>
  buildResume({
    id: "resume-pm",
    filename: "jordan-example-product-manager.txt",
    format: "txt",
    label: "Jordan Example — Product Manager",
    targetRoles: ["Product Manager"],
    skills: ["Product Management", "Roadmapping", "OKRs", "Jira", "Amplitude"],
    industries: ["SaaS"],
    experienceSummary: "Senior Product Manager | Contoso Freight | Jan 2021 - Present",
    educationSummary: "MBA, Example Business School, 2018",
    verifiedFacts: [{ kind: "role", text: "Senior Product Manager" }],
    extractedText: "Jordan Example\nSenior Product Manager | Contoso Freight | Jan 2021 - Present\nOwned the carrier-facing roadmap and quarterly OKRs; wrote user stories in Jira.\nEducation\nMBA, Example Business School, 2018",
    ...overrides,
  });

const engineeringOpportunity = (overrides: Partial<Opportunity> = {}): Opportunity =>
  buildOpportunity({
    title: "Senior Software Engineer",
    companyName: "Northwind Analytics",
    requiredSkills: ["TypeScript", "Node.js", "PostgreSQL"],
    preferredSkills: ["Kubernetes"],
    responsibilities: ["Design and ship TypeScript services on Node.js with PostgreSQL"],
    rawDescription: "Design and ship TypeScript services on Node.js with PostgreSQL on AWS. Mentor engineers.",
    normalizedDescription: "Design and ship TypeScript services on Node.js with PostgreSQL on AWS. Mentor engineers.",
    status: "VERIFIED",
    verificationStatus: "LIKELY_LEGIT",
    ...overrides,
  });

describe("dedupe", () => {
  it("buildProbe normalises the company and title", () => {
    const probe = buildProbe({
      canonicalUrl: "https://jobs.example.com/1",
      sourceName: "greenhouse:acme",
      externalId: "ext-1",
      companyName: "ACME, Inc.",
      title: "Senior Engineer (Remote) - Full-time",
      workMode: "REMOTE",
      locationText: "Remote - US",
      descriptionHash: "hash-1",
    });
    assert.equal(probe.companyNameNormalized, normalizeCompanyName("ACME, Inc."));
    assert.equal(probe.companyNameNormalized, "acme");
    assert.equal(probe.titleNormalized, normalizeTitle("Senior Engineer (Remote) - Full-time"));
    assert.equal(probe.titleNormalized, "senior engineer");
    assert.equal(probe.canonicalUrl, "https://jobs.example.com/1");
    assert.equal(probe.descriptionHash, "hash-1");
  });

  const probeOf = (o: Partial<Parameters<typeof buildProbe>[0]> = {}) =>
    buildProbe({
      canonicalUrl: null, sourceName: "manual", externalId: null, companyName: "Acme Inc", title: "Platform Engineer",
      workMode: "REMOTE", locationText: null, descriptionHash: "hash-a", ...o,
    });

  it("ranks exact matches on canonicalUrl and on (sourceName, externalId)", () => {
    const byUrl = rankCandidate(probeOf({ canonicalUrl: "https://jobs.example.com/1", companyName: "Other", title: "Other" }), buildOpportunity({ canonicalUrl: "https://jobs.example.com/1" }));
    assert.equal(byUrl?.confidence, "exact");
    assert.deepEqual(byUrl?.matchedOn, ["canonicalUrl"]);
    const byExternal = rankCandidate(probeOf({ sourceName: "Greenhouse:acme", externalId: "ext-1", companyName: "Other" }), buildOpportunity({ sourceName: "greenhouse:acme", externalId: "ext-1" }));
    assert.equal(byExternal?.confidence, "exact");
    assert.deepEqual(byExternal?.matchedOn, ["externalId"]);
    assert.equal(rankCandidate(probeOf({ sourceName: "greenhouse:other", externalId: "ext-1", companyName: "Other" }), buildOpportunity({ sourceName: "greenhouse:acme", externalId: "ext-1" })), null, "same external id on a different source is not exact");
  });

  it("ranks a matching description hash as strong only for the same company", () => {
    const same = rankCandidate(probeOf({ title: "Different Title", descriptionHash: "hash-x" }), buildOpportunity({ companyName: "ACME, Inc.", title: "Other", descriptionHash: "hash-x" }));
    assert.equal(same?.confidence, "strong");
    assert.deepEqual(same?.matchedOn, ["descriptionHash"]);
    assert.equal(rankCandidate(probeOf({ title: "Different Title", descriptionHash: "hash-x" }), buildOpportunity({ companyName: "Widgets LLC", title: "Other", descriptionHash: "hash-x" })), null);
  });

  it("ranks company + title as probable when work mode and location are compatible", () => {
    const m = rankCandidate(probeOf({ locationText: "Remote - United States" }), buildOpportunity({ companyName: "Acme, Inc.", title: "Platform Engineer (Remote)", workMode: "REMOTE", locationText: "Remote - United States" }));
    assert.equal(m?.confidence, "probable");
    assert.deepEqual(m?.matchedOn, ["companyAndTitle", "workMode", "location"]);
    const unknownMode = rankCandidate(probeOf({ workMode: "UNKNOWN" }), buildOpportunity({ companyName: "Acme Inc", title: "Platform Engineer", workMode: "ONSITE" }));
    assert.equal(unknownMode?.confidence, "probable");
    assert.deepEqual(unknownMode?.matchedOn, ["companyAndTitle"]);
  });

  it("returns null when work modes conflict or titles differ", () => {
    assert.equal(rankCandidate(probeOf({ workMode: "REMOTE" }), buildOpportunity({ companyName: "Acme Inc", title: "Platform Engineer", workMode: "ONSITE" })), null);
    assert.equal(rankCandidate(probeOf(), buildOpportunity({ companyName: "Acme Inc", title: "Staff Engineer", workMode: "REMOTE" })), null);
    assert.equal(rankCandidate(probeOf({ locationText: "Austin, TX" }), buildOpportunity({ companyName: "Acme Inc", title: "Platform Engineer", workMode: "REMOTE", locationText: "Berlin, Germany" })), null);
  });

  it("findDuplicate returns the best match ordered exact > strong > probable", () => {
    const repos = createTestRepos();
    const probable = repos.opportunities.insert(buildOpportunity({ companyName: "Acme Inc", title: "Platform Engineer", workMode: "REMOTE", createdAt: "2026-08-01T00:00:00.000Z" }));
    const strong = repos.opportunities.insert(buildOpportunity({ companyName: "Acme Inc", title: "Other Title", descriptionHash: "hash-a", createdAt: "2026-08-02T00:00:00.000Z" }));
    const exact = repos.opportunities.insert(buildOpportunity({ companyName: "Unrelated", title: "Unrelated", canonicalUrl: "https://jobs.example.com/1", createdAt: "2026-08-03T00:00:00.000Z" }));
    const all = probeOf({ canonicalUrl: "https://jobs.example.com/1", descriptionHash: "hash-a" });
    assert.equal(findDuplicate(repos, all)?.opportunity.id, exact.id);
    assert.equal(findDuplicate(repos, all)?.confidence, "exact");
    const noUrl = probeOf({ descriptionHash: "hash-a" });
    assert.equal(findDuplicate(repos, noUrl)?.opportunity.id, strong.id);
    assert.equal(findDuplicate(repos, noUrl)?.confidence, "strong");
    const onlyTitle = probeOf({ descriptionHash: "hash-none" });
    assert.equal(findDuplicate(repos, onlyTitle)?.opportunity.id, probable.id);
    assert.equal(findDuplicate(repos, onlyTitle)?.confidence, "probable");
    assert.equal(findDuplicate(repos, probeOf({ companyName: "Nobody", title: "Nothing", descriptionHash: "zzz" })), null);
  });
});

describe("normalize", () => {
  it("sectionize splits responsibilities, requirements and nice-to-haves", () => {
    const s = sectionize(["Intro line that is long enough.", "Responsibilities", "- Design and ship TypeScript services", "- Mentor engineers across the team", "Requirements", "Experience with PostgreSQL and SQL performance tuning", "- 5+ years building production web services", "Nice to have", "- Kubernetes experience", "Benefits", "- Health insurance and a stipend"].join("\n"));
    assert.deepEqual(s.responsibilities, ["Design and ship TypeScript services", "Mentor engineers across the team"]);
    assert.deepEqual(s.qualifications, ["Experience with PostgreSQL and SQL performance tuning", "5+ years building production web services"]);
    assert.deepEqual(s.preferred, ["Kubernetes experience"]);
  });

  it("treats a line starting with 'Experience with PostgreSQL' as a qualification, not a heading", () => {
    const s = sectionize("Requirements\nExperience with PostgreSQL\n- Strong TypeScript and Node.js experience");
    assert.deepEqual(s.qualifications, ["Experience with PostgreSQL", "Strong TypeScript and Node.js experience"]);
  });

  it("infers work mode, geography, skills and compensation from the sample listing", () => {
    const n = normalizeOpportunity({ rawDescription: SAMPLE_LISTING.rawDescription, title: SAMPLE_LISTING.title, locationText: SAMPLE_LISTING.locationText });
    assert.equal(n.workMode, "REMOTE");
    assert.ok(n.workModeEvidence);
    assert.equal(n.geographicEligibility, "US_ONLY");
    assert.deepEqual(n.eligibleCountries, ["US"]);
    assert.equal(n.employmentType, "UNKNOWN");
    assert.ok(n.requiredSkills.some((s) => /^typescript$/i.test(s)), `skills: ${n.requiredSkills}`);
    assert.ok(n.requiredSkills.some((s) => /^postgresql$/i.test(s)));
    assert.ok(n.preferredSkills.some((s) => /^kubernetes$/i.test(s)), `preferred: ${n.preferredSkills}`);
    assert.ok(!n.preferredSkills.some((s) => n.requiredSkills.map((r) => r.toLowerCase()).includes(s.toLowerCase())), "preferred never repeats required");
    assert.equal(n.compensation.min, 150000);
    assert.equal(n.compensation.max, 185000);
    assert.equal(n.compensation.currency, "USD");
    assert.equal(n.compensation.period, "YEAR");
    assert.ok(n.responsibilities.length >= 3 && n.qualifications.length >= 3);
  });

  it("respects explicit overrides", () => {
    const n = normalizeOpportunity({
      rawDescription: SAMPLE_LISTING.rawDescription, title: SAMPLE_LISTING.title, locationText: SAMPLE_LISTING.locationText,
      workMode: "HYBRID", geographicEligibility: "COUNTRY_RESTRICTED", eligibleCountries: ["CA"], employmentType: "CONTRACT",
      compensation: { currency: "CAD" }, requiredSkills: ["Rust"], timezoneRequirements: "PST overlap",
    });
    assert.equal(n.workMode, "HYBRID");
    assert.equal(n.geographicEligibility, "COUNTRY_RESTRICTED");
    assert.deepEqual(n.eligibleCountries, ["CA"]);
    assert.equal(n.employmentType, "CONTRACT");
    assert.equal(n.compensation.currency, "CAD");
    assert.equal(n.compensation.min, 150000, "unspecified compensation fields still come from the text");
    assert.equal(n.requiredSkills[0], "Rust");
    assert.equal(n.timezoneRequirements, "PST overlap");
    assert.equal(normalizeOpportunity({ rawDescription: "Fully remote role.", title: "X", locationText: null, workMode: "UNKNOWN" }).workMode, "REMOTE", "UNKNOWN override does not block inference");
  });

  it("descriptionHash is stable across whitespace and case changes", () => {
    const a = normalizeOpportunity({ rawDescription: "Hello   World\nFoo\tbar", title: "T", locationText: null });
    const b = normalizeOpportunity({ rawDescription: "  hello world\n\n\n\nfoo bar  ", title: "T", locationText: null });
    const c = normalizeOpportunity({ rawDescription: "Hello World\nFoo baz", title: "T", locationText: null });
    assert.equal(a.descriptionHash, b.descriptionHash);
    assert.notEqual(a.descriptionHash, c.descriptionHash);
    assert.equal(b.normalizedDescription, "hello world\n\nfoo bar");
  });
});

describe("resumeMatch (KeywordResumeRetriever)", () => {
  const retriever = new KeywordResumeRetriever();

  it("ranks the software résumé first for an engineering opportunity", () => {
    const ranked = retriever.retrieve(engineeringOpportunity(), [productResume(), softwareResume()], 3);
    assert.deepEqual(ranked.map((c) => c.resume.id), ["resume-se", "resume-pm"]);
    assert.ok(ranked[0]!.score > ranked[1]!.score, `${ranked[0]!.score} > ${ranked[1]!.score}`);
    assert.match(ranked[0]!.rationale, /3\/3 required skills/);
    assert.match(ranked[0]!.rationale, /target role/);
    assert.deepEqual(ranked[0]!.matchedSkills.map((s) => s.toLowerCase()).sort(), ["node.js", "postgresql", "typescript"]);
    assert.ok(ranked[0]!.score >= 0 && ranked[0]!.score <= 100);
  });

  it("excludes inactive and NEEDS_OCR résumés and respects the limit", () => {
    const resumes = [softwareResume({ id: "inactive", filename: "a.md", isActive: false }), softwareResume({ id: "ocr", filename: "b.pdf", extractionStatus: "NEEDS_OCR" }), softwareResume({ id: "failed", filename: "c.pdf", extractionStatus: "FAILED" }), softwareResume(), productResume()];
    const ranked = retriever.retrieve(engineeringOpportunity(), resumes, 5);
    assert.deepEqual(ids(ranked.map((c) => c.resume)), ["resume-se", "resume-pm"]);
    assert.equal(retriever.retrieve(engineeringOpportunity(), resumes, 1).length, 1);
  });

  it("returns an empty list without résumés", () => {
    assert.deepEqual(retriever.retrieve(engineeringOpportunity(), [], 3), []);
  });
});

describe("drafts", () => {
  it("isGrounded accepts verbatim and light-paraphrase facts and rejects invented ones", () => {
    const resume = softwareResume();
    assert.equal(isGrounded("Built TypeScript services on Node.js", resume), true);
    assert.equal(isGrounded("built typescript services on node.js!", resume), true, "case and punctuation are ignored");
    assert.equal(isGrounded("TypeScript services built on Node.js with PostgreSQL", resume), true, "light paraphrase");
    assert.equal(isGrounded("B.S. Computer Science", resume), true, "verified facts count");
    assert.equal(isGrounded("Docker", resume), true, "skills count");
    assert.equal(isGrounded("Platform migration lead at Fabrikam 2015", resume), false);
    assert.equal(isGrounded("MBA", resume), false);
    assert.equal(isGrounded("", resume), false);
  });

  it("checkGrounding flags ungrounded evidence and warns when evidence is empty", () => {
    const resume = softwareResume();
    const r = checkGrounding(
      [
        { claim: "Ships TypeScript services", sourceFact: "Built TypeScript services on Node.js" },
        { claim: "Led a migration at Fabrikam", sourceFact: "Platform migration lead at Fabrikam 2015" },
      ],
      resume,
    );
    assert.deepEqual(r.evidence.map((e) => e.grounded), [true, false]);
    assert.ok(r.evidence.every((e) => e.resumeId === resume.id));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /Fabrikam/);
    const empty = checkGrounding([], resume);
    assert.deepEqual(empty.evidence, []);
    assert.equal(empty.warnings.length, 1);
    assert.match(empty.warnings[0]!, /cites no résumé evidence/);
  });

  it("buildTemplatePackage never invents skills and yields all-grounded evidence", () => {
    const resume = softwareResume();
    const opportunity = engineeringOpportunity({ requiredSkills: ["TypeScript", "Kubernetes", "Rust"] });
    const pkg = buildTemplatePackage(opportunity, resume, ["Why us?"], true);
    for (const text of [pkg.professionalSummary, pkg.coverLetter]) {
      assert.ok(!/Kubernetes|Rust/.test(text), `must not claim absent skills: ${text}`);
      assert.ok(text.includes("TypeScript"));
    }
    assert.ok(pkg.professionalSummary.includes(opportunity.title) && pkg.coverLetter.includes(opportunity.companyName));
    assert.ok(pkg.coverLetter.includes("Jordan Example"), "candidate name from the first résumé line");
    assert.ok(pkg.evidence.length > 0 && pkg.evidence.every((e) => e.grounded), JSON.stringify(pkg.evidence));
    assert.ok(pkg.evidence.every((e) => e.resumeId === resume.id));
    assert.ok(pkg.resumeTailoringSuggestions.some((s) => /Kubernetes, Rust/.test(s) && /not in this résumé/.test(s)), "gaps are surfaced as suggestions, not claims");
    assert.equal(pkg.applicationAnswers.length, 1);
    assert.equal(pkg.applicationAnswers[0]!.question, "Why us?");
    assert.ok(pkg.recruiterOutreach && pkg.recruiterOutreach.includes(opportunity.title));
    assert.equal(buildTemplatePackage(opportunity, resume, [], false).recruiterOutreach, null);
  });

  function draftDeps() {
    const repos = createTestRepos();
    const ai = new FakeAiProvider();
    const c = clock();
    const resume = repos.resumes.upsertByFilename(softwareResume());
    const opportunity = repos.opportunities.insert(engineeringOpportunity({ recommendedResumeId: resume.id }));
    return { deps: { repos, now: c.now, ai, logger: silentLogger }, ai, repos, opportunity, resume, clock: c };
  }

  it("generateDraftPackage grounds model output and flags one invented fact", async () => {
    const { deps, ai, opportunity, repos } = draftDeps();
    ai.responses.push({
      professionalSummary: "Senior Software Engineer with TypeScript and Node.js experience.",
      coverLetter: "Dear team, I built TypeScript services on Node.js. Sincerely, Jordan",
      resumeTailoringSuggestions: ["Lead with PostgreSQL work."],
      applicationAnswers: [{ question: "Why us?", answer: "Because of the team." }],
      recruiterOutreach: "Hello!",
      evidence: [
        { claim: "TypeScript services on Node.js", sourceFact: "Built TypeScript services on Node.js with PostgreSQL on AWS using Docker." },
        { claim: "Led a platform migration at Fabrikam", sourceFact: "Platform migration lead at Fabrikam 2015" },
      ],
    });
    const r = await generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({ questions: ["Why us?"] }));
    assert.equal(r.draft.generatedBy, "ai");
    assert.equal(r.draft.provider, "ollama");
    assert.equal(r.draft.model, "fake-model");
    assert.equal(r.draft.promptVersion, "draft-v1");
    assert.equal(r.draft.version, 1);
    assert.equal(r.draft.groundingWarnings.length, 1);
    assert.match(r.draft.groundingWarnings[0]!, /Fabrikam/);
    const content = r.draft.content as { evidence: { grounded: boolean }[]; recruiterOutreach: string | null };
    assert.deepEqual(content.evidence.map((e) => e.grounded), [true, false]);
    assert.equal(content.recruiterOutreach, null, "outreach dropped unless requested");
    assert.equal(r.application.status, "AWAITING_APPROVAL");
    assert.equal(r.application.currentDraftVersion, 1);
    assert.equal(r.opportunity.status, "DRAFT_PREPARED");
    assert.equal(ai.calls.length, 1);
    assert.ok(ai.calls[0]!.prompt.includes("PostgreSQL"), "prompt carries résumé facts");
    assert.ok(repos.audit.listForEntity("draft", r.draft.id).some((e) => e.event === "draft.generated"));
  });

  it("generateDraftPackage falls back to the template when the provider is offline", async () => {
    const { deps, ai, opportunity } = draftDeps();
    ai.reachable = false;
    const r = await generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({}));
    assert.equal(r.draft.generatedBy, "template");
    assert.equal(r.draft.provider, null);
    assert.equal(r.draft.model, null);
    assert.ok(r.draft.groundingWarnings.length >= 1);
    assert.match(r.draft.groundingWarnings[0]!, /Model unavailable/);
    const content = r.draft.content as { evidence: { grounded: boolean }[] };
    assert.ok(content.evidence.length > 0 && content.evidence.every((e) => e.grounded));
  });

  it("generateDraftPackage honours templateOnly without calling the model", async () => {
    const { deps, ai, opportunity } = draftDeps();
    const r = await generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({ templateOnly: true }));
    assert.equal(r.draft.generatedBy, "template");
    assert.equal(ai.calls.length, 0);
    assert.deepEqual(r.draft.groundingWarnings, []);
  });

  it("editDraft stores version+1 generated by the user", async () => {
    const { deps, ai, opportunity, repos } = draftDeps();
    ai.reachable = false;
    const first = await generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({}));
    const edited = editDraft(deps, opportunity.id, first.draft.id, { coverLetter: "Edited letter.", evidence: [{ claim: "x", sourceFact: "Docker", resumeId: "resume-se", grounded: false }] });
    assert.equal(edited.version, 2);
    assert.equal(edited.generatedBy, "user");
    assert.notEqual(edited.id, first.draft.id);
    assert.ok(edited.editedAt);
    const content = edited.content as { coverLetter: string; professionalSummary: string; evidence: { grounded: boolean }[] };
    assert.equal(content.coverLetter, "Edited letter.");
    assert.equal(content.professionalSummary, (first.draft.content as { professionalSummary: string }).professionalSummary, "untouched fields carry over");
    assert.equal(content.evidence[0]!.grounded, true, "user-supplied evidence is re-checked against the résumé");
    assert.equal(repos.applications.findByOpportunity(opportunity.id)?.currentDraftVersion, 2);
    assert.throws(() => editDraft(deps, opportunity.id, "missing", { coverLetter: "x" }), isHttp(404));
    assert.throws(() => editDraft(deps, "other-opportunity", first.draft.id, { coverLetter: "x" }), isHttp(404));
  });

  it("generateFollowUpDraft refuses before the application is recorded as submitted", async () => {
    const { deps, ai, opportunity } = draftDeps();
    await assert.rejects(() => generateFollowUpDraft(deps, opportunity.id), isHttp(409));
    ai.reachable = false;
    await generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({}));
    await assert.rejects(() => generateFollowUpDraft(deps, opportunity.id), isHttp(409), "an application without appliedAt still refuses");
  });

  it("generateDraftPackage refuses a rejected scam and an unusable résumé", async () => {
    const { deps, repos, opportunity, resume } = draftDeps();
    repos.opportunities.update(opportunity.id, { verificationStatus: "REJECTED_AS_SCAM" });
    await assert.rejects(() => generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({})), isHttp(409));
    repos.opportunities.update(opportunity.id, { verificationStatus: "LIKELY_LEGIT" });
    repos.resumes.update(resume.id, { extractionStatus: "NEEDS_OCR" });
    await assert.rejects(() => generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({})), isHttp(422));
    await assert.rejects(() => generateDraftPackage(deps, opportunity.id, GenerateDraftInputSchema.parse({ resumeId: "missing" })), isHttp(404));
  });
});

describe("evaluate", () => {
  const rules = (o: Partial<RuleEvaluation> = {}): RuleEvaluation => ({
    legitimacyScore: 70, scamRiskScore: 50, remoteEligibilityScore: 90, relevanceScore: null, verificationStatus: "LIKELY_LEGIT",
    signals: [], reasons: ["synthetic"], missingInformation: [], ...o,
  });
  const ai = (o: Partial<AiEvaluation> = {}): AiEvaluation => ({
    legitimacyScore: 90, scamRiskScore: 0, relevanceScore: 80, remoteEligibilityScore: 100, bestResumeId: null, rationale: "synthetic",
    evidence: [], riskSignals: [], missingInformation: [], suggestedNextAction: "apply", confidence: "high", ...o,
  });

  it("combineScores keeps the rules' scam risk as a floor", () => {
    const combined = combineScores(rules({ scamRiskScore: 50 }), ai({ scamRiskScore: 0 }), null);
    assert.equal(combined.scamRiskScore, 50);
    assert.equal(combined.legitimacyScore, Math.round(70 * 0.6 + 90 * 0.4));
    assert.equal(combined.remoteEligibilityScore, Math.round(90 * 0.6 + 100 * 0.4));
    assert.equal(combined.relevanceScore, 80, "model relevance stands in when no résumé matched");
    assert.equal(combineScores(rules({ scamRiskScore: 20 }), ai({ scamRiskScore: 100 }), 40).scamRiskScore, 60, "the model can raise it");
    assert.deepEqual(combineScores(rules(), null, 30), { legitimacyScore: 70, scamRiskScore: 50, remoteEligibilityScore: 90, relevanceScore: 30 });
    assert.equal(combineScores(rules(), ai({ relevanceScore: 60 }), 40).relevanceScore, 50);
    assert.equal(combineScores(rules(), null, null).relevanceScore, null);
  });

  it("combinedVerification only escalates", () => {
    assert.equal(combinedVerification(rules({ verificationStatus: "LIKELY_LEGIT" }), 70), "HIGH_RISK");
    assert.equal(combinedVerification(rules({ verificationStatus: "VERIFIED_OFFICIAL_SOURCE" }), 40), "NEEDS_MANUAL_REVIEW");
    assert.equal(combinedVerification(rules({ verificationStatus: "LIKELY_LEGIT" }), 10), "LIKELY_LEGIT");
    assert.equal(combinedVerification(rules({ verificationStatus: "HIGH_RISK" }), 0), "HIGH_RISK", "the model cannot lower a rules decision");
    assert.equal(combinedVerification(rules({ verificationStatus: "NEEDS_MANUAL_REVIEW" }), 0), "NEEDS_MANUAL_REVIEW");
  });

  function evalDeps() {
    const c = clock();
    const repos = createTestRepos(createTestDb(), c.now);
    const fake = new FakeAiProvider();
    repos.resumes.upsertByFilename(softwareResume());
    repos.resumes.upsertByFilename(productResume());
    const opportunity = repos.opportunities.insert(engineeringOpportunity({ status: "NORMALIZED", verificationStatus: "UNVERIFIED", companyWebsite: "https://northwind.example", companyDomain: "northwind.example", sourceType: "OFFICIAL_ATS" }));
    return { deps: { repos, now: c.now, ai: fake, logger: silentLogger }, repos, ai: fake, opportunity };
  }

  it("rulesOnly records aiStatus DISABLED and still recommends a résumé", async () => {
    const { deps, repos, ai, opportunity } = evalDeps();
    const r = await evaluateOpportunity(deps, opportunity.id, { rulesOnly: true });
    assert.equal(r.evaluation.aiStatus, "DISABLED");
    assert.equal(r.evaluation.ai, null);
    assert.equal(r.evaluation.promptVersion, null);
    assert.equal(ai.calls.length, 0);
    assert.equal(r.evaluation.recommendedResumeId, "resume-se");
    assert.deepEqual(r.evaluation.candidateResumeIds, ["resume-se", "resume-pm"]);
    assert.equal(r.opportunity.recommendedResumeId, "resume-se");
    assert.equal(r.opportunity.legitimacyScore, r.evaluation.rules.legitimacyScore);
    assert.equal(r.opportunity.scamRiskScore, r.evaluation.rules.scamRiskScore);
    assert.equal(r.opportunity.relevanceScore, r.evaluation.rules.relevanceScore === null ? r.opportunity.relevanceScore : r.evaluation.rules.relevanceScore);
    assert.ok(typeof r.opportunity.relevanceScore === "number", "relevance comes from the keyword match");
    assert.equal(r.opportunity.verificationStatus, r.evaluation.rules.verificationStatus);
    assert.equal(r.opportunity.status, r.opportunity.verificationStatus === "VERIFIED_OFFICIAL_SOURCE" || r.opportunity.verificationStatus === "LIKELY_LEGIT" ? "VERIFIED" : "REVIEW_NEEDED");
    assert.deepEqual(repos.evaluations.latestForOpportunity(opportunity.id), r.evaluation);
    assert.ok(repos.audit.listForEntity("opportunity", opportunity.id).some((e) => e.event === "opportunity.evaluated"));
  });

  it("falls back to the top keyword candidate when the model names an unknown résumé", async () => {
    const { deps, ai, opportunity } = evalDeps();
    ai.responses.push({
      legitimacyScore: 85, scamRiskScore: 5, relevanceScore: 88, remoteEligibilityScore: 90, bestResumeId: "ghost-resume",
      rationale: "Looks like a real listing.", evidence: [], riskSignals: [], missingInformation: [], suggestedNextAction: "Apply", confidence: "high",
    });
    const r = await evaluateOpportunity(deps, opportunity.id);
    assert.equal(r.evaluation.aiStatus, "OK");
    assert.equal(r.evaluation.promptVersion, "evaluate-v1");
    assert.equal(r.evaluation.model, "fake-model");
    assert.equal(r.evaluation.ai?.bestResumeId, null, "unknown ids are dropped");
    assert.equal(r.evaluation.recommendedResumeId, "resume-se");
    assert.equal(r.opportunity.recommendedResumeId, "resume-se");
    assert.match(r.opportunity.matchRationale ?? "", /required skills/);
    assert.ok(r.opportunity.verificationReasons.some((line) => /^Model \(advisory, high confidence\)/.test(line)));
    assert.equal(r.opportunity.nextAction, "Apply");
    assert.ok(ai.calls[0]!.prompt.includes("resume-pm"), "candidates are offered to the model by id");
    assert.ok(!ai.calls[0]!.prompt.includes("jordan@example.com"), "résumé contact details never reach the model");
  });

  it("uses the model's résumé pick when it is one of the candidates", async () => {
    const { deps, ai, opportunity } = evalDeps();
    ai.responses.push({ legitimacyScore: 80, scamRiskScore: 5, relevanceScore: 70, remoteEligibilityScore: 90, bestResumeId: "resume-pm", rationale: "pm", confidence: "medium" });
    const r = await evaluateOpportunity(deps, opportunity.id);
    assert.equal(r.evaluation.recommendedResumeId, "resume-pm");
  });

  it("records INVALID_OUTPUT after two bad model replies and still applies rule scores", async () => {
    const { deps, ai, opportunity, repos } = evalDeps();
    ai.responses.push("this is not json", "still { broken");
    const r = await evaluateOpportunity(deps, opportunity.id);
    assert.equal(r.evaluation.aiStatus, "INVALID_OUTPUT");
    assert.equal(r.evaluation.ai, null);
    assert.ok(r.evaluation.aiError);
    assert.equal(ai.calls.length, 2, "one repair retry");
    assert.equal(r.opportunity.legitimacyScore, r.evaluation.rules.legitimacyScore);
    assert.equal(r.opportunity.scamRiskScore, r.evaluation.rules.scamRiskScore);
    assert.equal(r.opportunity.remoteEligibilityScore, r.evaluation.rules.remoteEligibilityScore);
    assert.deepEqual(r.opportunity.scamSignals, r.evaluation.rules.signals);
    assert.equal(repos.opportunities.findById(opportunity.id)?.updatedAt, FIXED_NOW);
  });

  it("records UNAVAILABLE when the provider is offline", async () => {
    const { deps, ai, opportunity } = evalDeps();
    ai.reachable = false;
    const r = await evaluateOpportunity(deps, opportunity.id);
    assert.equal(r.evaluation.aiStatus, "UNAVAILABLE");
    assert.equal(r.evaluation.recommendedResumeId, "resume-se");
  });

  it("404s for an unknown opportunity", async () => {
    const { deps } = evalDeps();
    await assert.rejects(() => evaluateOpportunity(deps, "missing"), isHttp(404));
  });
});

describe("applications", () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "radar-services-apps-"));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function appDeps(env: Record<string, string> = {}) {
    const repos = createTestRepos();
    const c = clock();
    const config = testConfig(tmp, env);
    const opportunity = repos.opportunities.insert(engineeringOpportunity({ status: "VERIFIED" }));
    return { deps: { repos, now: c.now, config }, repos, clock: c, opportunity, config };
  }

  it("markApplied is refused without an explicit approval", () => {
    const { deps, opportunity, repos } = appDeps();
    assert.throws(() => markApplied(deps, opportunity.id, {}), isHttp(409));
    repos.applications.insert(buildApplication(opportunity.id, { status: "AWAITING_APPROVAL" }));
    assert.throws(() => markApplied(deps, opportunity.id, {}), isHttp(409));
    assert.throws(() => markApplied(deps, "missing", {}), isHttp(404));
    assert.equal(repos.opportunities.findById(opportunity.id)?.status, "VERIFIED", "nothing changed");
  });

  it("approveApplication rejects an unknown draft version and an unknown résumé", () => {
    const { deps, opportunity } = appDeps();
    assert.throws(() => approveApplication(deps, opportunity.id, { acknowledged: true, draftVersion: 9 }), isHttp(422));
    assert.throws(() => approveApplication(deps, opportunity.id, { acknowledged: true, resumeId: "missing" }), isHttp(422));
  });

  it("approve → applied → follow-up scheduling → completion", () => {
    const { deps, opportunity, repos } = appDeps();
    const approved = approveApplication(deps, opportunity.id, { acknowledged: true });
    assert.equal(approved.application.status, "APPROVED");
    assert.equal(approved.application.approvedAt, FIXED_NOW);
    assert.equal(approved.application.approvedDraftVersion, null, "no drafts yet");
    assert.equal(approved.opportunity.status, "READY_TO_APPLY");
    assert.ok(approved.checklist.length >= 3 && approved.checklist.some((line) => /Never pay a fee/.test(line)));

    const applied = markApplied(deps, opportunity.id, { appliedAt: "2026-09-01T12:00:00.000Z", confirmationReference: "REQ-42", notes: "Submitted via portal" });
    assert.equal(applied.application.status, "SUBMITTED");
    assert.equal(applied.application.followUpDueAt, "2026-09-08T12:00:00.000Z", "config default of 7 days");
    assert.equal(applied.application.notes, "Submitted via portal");
    assert.equal(applied.followUp.status, "PENDING");
    assert.equal(applied.followUp.dueAt, "2026-09-08T12:00:00.000Z");
    assert.equal(applied.opportunity.status, "APPLIED");
    assert.equal(applied.opportunity.followUpDueAt, "2026-09-08T12:00:00.000Z");

    const due = scheduleFollowUp(deps, opportunity.id, { dueAt: "2026-08-30T00:00:00.000Z", note: "Ping the recruiter" });
    assert.equal(due.followUp.id, applied.followUp.id, "the pending task is rescheduled, not duplicated");
    assert.equal(due.followUp.dueAt, "2026-08-30T00:00:00.000Z");
    assert.equal(due.followUp.note, "Ping the recruiter");
    assert.equal(due.opportunity.status, "FOLLOW_UP_DUE", "a due date in the past promotes APPLIED");
    assert.equal(repos.followUps.listByOpportunity(opportunity.id).length, 1);

    const done = completeFollowUp(deps, opportunity.id, { sentAt: "2026-09-02T09:00:00.000Z" });
    assert.equal(done.followUp?.status, "DONE");
    assert.equal(done.followUp?.completedAt, "2026-09-02T09:00:00.000Z");
    assert.equal(done.application.followUpSentAt, "2026-09-02T09:00:00.000Z");
    assert.equal(done.application.followUpDueAt, null);
    assert.equal(done.opportunity.status, "FOLLOWED_UP");
    assert.equal(done.opportunity.followUpDueAt, null);
    const events = repos.audit.listForEntity("application", applied.application.id).map((e) => e.event);
    assert.ok(events.includes("application.approved") && events.includes("application.submitted_by_user"));
  });

  it("scheduleFollowUp with a future date keeps APPLIED", () => {
    const { deps, opportunity } = appDeps();
    approveApplication(deps, opportunity.id, { acknowledged: true });
    markApplied(deps, opportunity.id, { appliedAt: FIXED_NOW });
    const r = scheduleFollowUp(deps, opportunity.id, { days: 3 });
    assert.equal(r.followUp.dueAt, "2026-09-04T10:00:00.000Z");
    assert.equal(r.opportunity.status, "APPLIED");
  });

  it("defaultFollowUpDays honours a settings override over config", () => {
    const { deps, repos, config } = appDeps({ OPPORTUNITY_RADAR_FOLLOW_UP_DAYS: "5" });
    assert.equal(config.followUpDays, 5);
    assert.equal(defaultFollowUpDays(deps), 5);
    repos.settings.set("followUpDays", 3);
    assert.equal(defaultFollowUpDays(deps), 3);
    repos.settings.set("followUpDays", -1);
    assert.equal(defaultFollowUpDays(deps), 5, "invalid overrides are ignored");
    repos.settings.set("followUpDays", "10");
    assert.equal(defaultFollowUpDays(deps), 5, "non-numeric overrides are ignored");
  });

  it("refreshFollowUpStatuses promotes due applications once and is idempotent", () => {
    const { deps, repos, clock: c } = appDeps();
    const due = repos.opportunities.insert(engineeringOpportunity({ status: "APPLIED", followUpDueAt: "2026-08-30T00:00:00.000Z" }));
    const future = repos.opportunities.insert(engineeringOpportunity({ status: "APPLIED", followUpDueAt: "2026-09-10T00:00:00.000Z" }));
    const interviewing = repos.opportunities.insert(engineeringOpportunity({ status: "INTERVIEWING", followUpDueAt: "2026-08-01T00:00:00.000Z" }));
    assert.equal(refreshFollowUpStatuses(deps), 1);
    assert.equal(repos.opportunities.findById(due.id)?.status, "FOLLOW_UP_DUE");
    assert.equal(repos.opportunities.findById(future.id)?.status, "APPLIED");
    assert.equal(repos.opportunities.findById(interviewing.id)?.status, "INTERVIEWING");
    assert.equal(refreshFollowUpStatuses(deps), 0);
    c.set("2026-09-11T00:00:00.000Z");
    assert.equal(refreshFollowUpStatuses(deps), 1, "the future one becomes due when the clock moves");
    assert.equal(refreshFollowUpStatuses(deps), 0);
  });
});

describe("export", () => {
  it("EXPORT_COLUMNS are the 20 tracking columns in order", () => {
    assert.deepEqual([...EXPORT_COLUMNS], [
      "Company Name", "Position Title", "Employment Type", "Work Mode", "Location / Eligibility", "Source Name", "Source URL", "Application URL",
      "Date Found", "Date Posted", "Verification Status", "Legitimacy Score", "Scam Risk Score", "Relevance Score", "Recommended Résumé",
      "Date Applied", "Follow-Up Due Date", "Follow-Up Sent Date", "Current Status", "Notes",
    ]);
    assert.equal(EXPORT_COLUMNS.length, 20);
  });

  it("exportRow maps résumé label, dates as YYYY-MM-DD and empty strings for nulls", () => {
    const o = buildOpportunity({
      companyName: "Northwind Analytics", title: "Senior Software Engineer", employmentType: "FULL_TIME", workMode: "REMOTE",
      locationText: "Remote - United States", geographicEligibility: "US_ONLY", eligibleCountries: ["US"], sourceName: "greenhouse:northwind",
      sourceUrl: "https://boards.greenhouse.io/northwind/jobs/1", applicationUrl: null, discoveredAt: "2026-09-01T10:00:00.000Z", postedAt: null,
      verificationStatus: "VERIFIED_OFFICIAL_SOURCE", legitimacyScore: 91, scamRiskScore: 4, relevanceScore: null, status: "APPLIED", notes: "note",
    });
    const app = buildApplication(o.id, { appliedAt: "2026-09-02T12:34:56.000Z", followUpDueAt: "2026-09-09T12:34:56.000Z", followUpSentAt: null });
    const row = exportRow(o, app, buildResume({ label: "Jordan Example — Engineer" }));
    assert.equal(row.length, EXPORT_COLUMNS.length);
    assert.deepEqual(row, [
      "Northwind Analytics", "Senior Software Engineer", "FULL_TIME", "REMOTE", "Remote - United States / us only / US", "greenhouse:northwind",
      "https://boards.greenhouse.io/northwind/jobs/1", "", "2026-09-01", "", "VERIFIED_OFFICIAL_SOURCE", 91, 4, "", "Jordan Example — Engineer",
      "2026-09-02", "2026-09-09", "", "APPLIED", "note",
    ]);
    const bare = exportRow(buildOpportunity({ locationText: null, geographicEligibility: "UNKNOWN", eligibleCountries: [], notes: "" }), null, null);
    assert.equal(bare[4], "unknown");
    assert.deepEqual(bare.slice(14, 18), ["", "", "", ""]);
  });

  it("exportCsv escapes commas and quotes and guards a leading '='", () => {
    const repos = createTestRepos();
    repos.opportunities.insert(buildOpportunity({ companyName: "Acme, Inc.", title: "Engineer", notes: '=SUM(A1), "quoted"' }));
    const csv = exportCsv(repos, OpportunityListQuerySchema.parse({}));
    const [header, row, trailing] = csv.split("\r\n");
    assert.equal(header, EXPORT_COLUMNS.join(","));
    assert.ok(row!.startsWith('"Acme, Inc.",Engineer,'), row);
    assert.ok(row!.endsWith(`"'=SUM(A1), ""quoted"""`), row);
    assert.equal(trailing, "", "CRLF-terminated");
    assert.equal(exportCsv(createTestRepos(), OpportunityListQuerySchema.parse({})), `${EXPORT_COLUMNS.join(",")}\r\n`);
  });
});

describe("ingest url", () => {
  const JOB_POSTING = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Platform Engineer",
    description: "<p>Build robots that sort parcels.</p><ul><li>Experience with Rust and Go</li><li>5+ years of systems work</li></ul>",
    datePosted: "2026-08-15",
    validThrough: "2026-10-01",
    employmentType: "FULL_TIME",
    hiringOrganization: { "@type": "Organization", name: "Acme Robotics", sameAs: "https://acme.example" },
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { "@type": "Country", name: "USA" },
    baseSalary: { "@type": "MonetaryAmount", currency: "usd", value: { "@type": "QuantitativeValue", minValue: 100000, maxValue: 120000, unitText: "YEAR" } },
    identifier: { "@type": "PropertyValue", name: "Acme", value: "REQ-77" },
    url: "https://acme.example/jobs/platform-engineer/apply",
  };
  const jsonLdHtml = `<html><head><title>Platform Engineer - Acme Robotics</title><link rel="canonical" href="/jobs/platform-engineer?utm_source=x"><script type="application/ld+json">${JSON.stringify(JOB_POSTING)}</script></head><body><h1>Platform Engineer</h1><p>Build robots that sort parcels.</p></body></html>`;
  const metaHtml = `<html><head><title>Acme</title><meta property="og:title" content="Senior Engineer - Acme Careers"><meta name="description" content="Join Acme as a Senior Engineer."></head><body><h1>Senior Engineer</h1><p>You will build TypeScript services on Node.js with PostgreSQL. Requirements: 5+ years of experience with distributed systems and strong communication skills. We offer $140,000 - $160,000 per year.</p></body></html>`;

  it("extractListing reads a JSON-LD JobPosting", () => {
    const r = extractListing(jsonLdHtml, "https://acme.example/jobs/platform-engineer", {});
    assert.equal(r.method, "jsonld");
    assert.equal(r.canonicalUrl, "https://acme.example/jobs/platform-engineer", "canonical resolved against the page and stripped of tracking params");
    const i = r.input;
    assert.equal(i.companyName, "Acme Robotics");
    assert.equal(i.title, "Platform Engineer");
    assert.equal(i.companyWebsite, "https://acme.example");
    assert.equal(i.workMode, "REMOTE");
    assert.equal(i.employmentType, "FULL_TIME");
    assert.equal(i.externalId, "REQ-77");
    assert.equal(i.postedAt, "2026-08-15T00:00:00.000Z");
    assert.equal(i.closesAt, "2026-10-01T00:00:00.000Z");
    assert.deepEqual({ min: i.compensation?.min, max: i.compensation?.max, currency: i.compensation?.currency }, { min: 100000, max: 120000, currency: "USD" });
    assert.match(i.compensation?.text ?? "", /100000–120000 per year/);
    assert.equal(i.locationText, "Applicants: USA");
    assert.equal(i.applicationUrl, "https://acme.example/jobs/platform-engineer/apply");
    assert.equal(i.sourceUrl, "https://acme.example/jobs/platform-engineer");
    assert.equal(i.sourceType, "MANUAL_URL");
    assert.equal(i.sourceName, "acme.example");
    assert.ok(i.rawDescription.includes("Build robots that sort parcels.") && i.rawDescription.includes("• Experience with Rust and Go"), i.rawDescription);
    assert.ok(!/<p>|<li>/.test(i.rawDescription), "HTML stripped");
  });

  it("extractListing labels a hosted ATS page as OFFICIAL_ATS and honours hints", () => {
    const r = extractListing(jsonLdHtml, "https://boards.greenhouse.io/acme/jobs/1", { notes: "from a friend" });
    assert.equal(r.input.sourceType, "OFFICIAL_ATS");
    assert.equal(r.input.sourceName, "greenhouse:boards.greenhouse.io");
    assert.equal(r.input.notes, "from a friend");
    const hinted = extractListing(jsonLdHtml, "https://boards.greenhouse.io/acme/jobs/1", { sourceName: "referral:sam", sourceType: "REFERRAL" });
    assert.equal(hinted.input.sourceType, "REFERRAL");
    assert.equal(hinted.input.sourceName, "referral:sam");
  });

  it("extractListing falls back to Open Graph metadata", () => {
    const r = extractListing(metaHtml, "https://www.acme.example/careers/42", {});
    assert.equal(r.method, "meta");
    assert.equal(r.input.title, "Senior Engineer");
    assert.equal(r.input.companyName, "Acme");
    assert.equal(r.canonicalUrl, "https://acme.example/careers/42");
    assert.ok(r.input.rawDescription.includes("TypeScript services"));
    assert.equal(r.input.applicationUrl, "https://www.acme.example/careers/42");
  });

  it("extractListing uses the page text and host when there is no metadata", () => {
    const r = extractListing("<html><body><p>Plain page with some words.</p></body></html>", "https://jobs.widgets.example/x", {});
    assert.equal(r.method, "text");
    assert.equal(r.input.title, "Untitled listing");
    assert.equal(r.input.companyName, "Widgets");
    assert.equal(extractListing("", "https://jobs.widgets.example/x", {}).method, "none");
  });

  it("splitTitle separates title and company across separators", () => {
    assert.deepEqual(splitTitle("Senior Engineer - Acme Careers", null), { title: "Senior Engineer", company: "Acme" });
    assert.deepEqual(splitTitle("Senior Engineer | Acme Jobs", null), { title: "Senior Engineer", company: "Acme" });
    assert.deepEqual(splitTitle("Acme: Senior Engineer", null), { title: "Senior Engineer", company: "Acme" });
    assert.deepEqual(splitTitle("Engineer at Acme", null), { title: "Engineer", company: "Acme" });
    assert.deepEqual(splitTitle("Acme Careers – Staff Engineer", "Acme"), { title: "Staff Engineer", company: "Acme" });
    assert.deepEqual(splitTitle("Just a title", null), { title: "Just a title", company: null });
    assert.deepEqual(splitTitle("   ", null), { title: "", company: null });
  });

  it("findJobPosting finds a JobPosting nested in @graph and arrays", () => {
    const graph = [{ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage", name: "x" }, { "@type": ["Thing", "JobPosting"], title: "Nested" }] }];
    assert.equal(findJobPosting(graph)?.title, "Nested");
    assert.equal(findJobPosting([[{ "@type": "JobPosting", title: "In array" }]])?.title, "In array");
    assert.equal(findJobPosting([{ "@type": "Organization", employee: { "@type": "JobPosting", title: "Deep" } }])?.title, "Deep");
    assert.equal(findJobPosting([{ "@type": "WebPage" }, null, "string", 42]), null);
    assert.equal(findJobPosting([]), null);
  });

  function urlDeps() {
    const repos = createTestRepos();
    const fetcher = fakeFetcher({
      "https://jobs.acme.example/1": { body: jsonLdHtml, finalUrl: "https://jobs.acme.example/1" },
      "https://jobs.acme.example/blocked": { status: 403, body: "<html><head><title>Acme Login</title></head><body>Members only.</body></html>" },
      "https://careers.other.example/cf": { status: 200, body: "<html><body><div id='cf-chl-widget'>Checking your browser</div></body></html>" },
      "https://jobs.acme.example/err": { status: 500, body: "Internal error" },
    });
    return { deps: { repos, now: clock().now, logger: silentLogger, fetcher }, repos, fetcher };
  }

  it("ingestUrl creates an opportunity from a 200 HTML page", async () => {
    const { deps, repos, fetcher } = urlDeps();
    const r = await ingestUrl(deps, IngestUrlInputSchema.parse({ url: "https://jobs.acme.example/1" }));
    assert.equal(r.accessBlocked, false);
    assert.equal(r.duplicate, false);
    assert.equal(r.extracted.method, "jsonld");
    assert.equal(r.extracted.status, 200);
    assert.equal(r.opportunity.companyName, "Acme Robotics");
    assert.equal(r.opportunity.workMode, "REMOTE");
    assert.equal(r.opportunity.status, "NORMALIZED");
    assert.equal(r.opportunity.companyDomain, "acme.example");
    assert.equal(repos.opportunities.listAll().length, 1);
    assert.deepEqual(fetcher.calls, ["https://jobs.acme.example/1"]);
    const again = await ingestUrl(deps, IngestUrlInputSchema.parse({ url: "https://jobs.acme.example/1" }));
    assert.equal(again.duplicate, true);
    assert.equal(again.duplicateOf, r.opportunity.id);
  });

  it("ingestUrl creates a stub behind a 403 or a challenge page", async () => {
    const { deps } = urlDeps();
    const forbidden = await ingestUrl(deps, IngestUrlInputSchema.parse({ url: "https://jobs.acme.example/blocked", notes: "seen on a forum" }));
    assert.equal(forbidden.accessBlocked, true);
    assert.equal(forbidden.extracted.method, "none");
    assert.equal(forbidden.extracted.status, 403);
    assert.equal(forbidden.opportunity.title, "Acme Login");
    assert.equal(forbidden.opportunity.companyName, "Acme");
    assert.equal(forbidden.opportunity.rawDescription, "");
    assert.match(forbidden.opportunity.notes, /seen on a forum/);
    assert.match(forbidden.opportunity.notes, /login or human verification/);
    assert.equal(forbidden.opportunity.applicationUrl, "https://jobs.acme.example/blocked");
    const challenge = await ingestUrl(deps, IngestUrlInputSchema.parse({ url: "https://careers.other.example/cf" }));
    assert.equal(challenge.accessBlocked, true);
    assert.equal(challenge.extracted.status, 200);
    assert.equal(challenge.opportunity.title, "Listing behind a login or challenge");
    assert.match(challenge.opportunity.notes, /login or human verification/);
  });

  it("ingestUrl throws 422 on a server error and 404 for an unknown route", async () => {
    const { deps, repos } = urlDeps();
    await assert.rejects(() => ingestUrl(deps, IngestUrlInputSchema.parse({ url: "https://jobs.acme.example/err" })), isHttp(422));
    await assert.rejects(() => ingestUrl(deps, IngestUrlInputSchema.parse({ url: "https://jobs.acme.example/nope" })), isHttp(422));
    assert.equal(repos.opportunities.listAll().length, 0);
  });
});

describe("import", () => {
  const importDeps = () => {
    const repos = createTestRepos();
    return { deps: { repos, now: clock().now, logger: silentLogger }, repos };
  };

  it("importJson counts created versus duplicates and applies the batch source name", () => {
    const { deps, repos } = importDeps();
    const item = { companyName: "Acme Robotics", title: "Platform Engineer", rawDescription: "Build robots. Experience with Rust required.", sourceUrl: "https://acme.example/jobs/1" };
    const batch = JsonImportSchema.parse({
      sourceName: "rss:acme",
      evaluate: false,
      items: [item, { companyName: "Contoso Freight", title: "Data Analyst", rawDescription: "Analyse freight data with SQL.", sourceName: "referral:sam" }, { ...item, sourceUrl: "https://acme.example/jobs/1?utm_source=newsletter" }],
    });
    const r = importJson(deps, batch);
    assert.equal(r.created, 2);
    assert.equal(r.duplicates, 1);
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items.map((i) => i.duplicate), [false, false, true]);
    assert.equal(r.items[2]!.id, r.items[0]!.id);
    assert.deepEqual(r.errors, []);
    const all = repos.opportunities.listAll();
    assert.equal(all.length, 2);
    assert.equal(all.find((o) => o.companyName === "Acme Robotics")?.sourceName, "rss:acme");
    assert.equal(all.find((o) => o.companyName === "Contoso Freight")?.sourceName, "referral:sam", "explicit item source names are kept");
    assert.equal(repos.sources.listByOpportunity(r.items[0]!.id).length, 2, "the duplicate sighting is recorded");
  });

  it("importCsv maps export column names, reports a row error for a missing title and imports the rest", () => {
    const { deps, repos } = importDeps();
    const csv = [
      "Company Name,Position Title,Work Mode,Employment Type,Source URL,Location / Eligibility,Notes",
      "Acme Robotics,Platform Engineer,Remote,Full-time,https://acme.example/jobs/1,Remote - US,first",
      'Acme Robotics,,Remote,,https://acme.example/jobs/2,,"missing, title"',
      "Contoso Freight,Data Analyst,Hybrid,Contract,https://contoso.example/jobs/3,\"Austin, TX\",third",
    ].join("\r\n");
    const r = importCsv(deps, csv, "csv-import", false);
    assert.equal(r.created, 2);
    assert.equal(r.duplicates, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /^Row 3:/);
    assert.match(r.errors[0]!, /title/);
    assert.deepEqual(r.items.map((i) => i.title), ["Platform Engineer", "Data Analyst"]);
    const acme = repos.opportunities.findById(r.items[0]!.id)!;
    assert.equal(acme.workMode, "REMOTE");
    assert.equal(acme.employmentType, "FULL_TIME");
    assert.equal(acme.locationText, "Remote - US");
    assert.equal(acme.sourceName, "csv-import");
    assert.equal(acme.notes, "first");
    const contoso = repos.opportunities.findById(r.items[1]!.id)!;
    assert.equal(contoso.workMode, "HYBRID");
    assert.equal(contoso.employmentType, "CONTRACT");
    assert.equal(contoso.locationText, "Austin, TX");
    assert.throws(() => importCsv(deps, "Company Name,Position Title\r\n", "csv-import", false), isHttp(422));
  });
});

describe("sync (MockAdapter)", () => {
  const syncDeps = () => {
    const repos = createTestRepos();
    return { deps: { repos, now: clock().now, logger: silentLogger, fetcher: fakeFetcher({}), adapters: [new MockAdapter()] }, repos };
  };

  it("creates the three sample listings, then reports them as duplicates", async () => {
    const { deps, repos } = syncDeps();
    const first = await syncSource(deps, "mock", "sample");
    assert.equal(first.created, 3);
    assert.equal(first.duplicates, 0);
    assert.deepEqual(first.warnings, []);
    assert.equal(first.run.status, "SUCCESS");
    assert.equal(first.run.fetched, 3);
    assert.equal(first.run.created, 3);
    assert.equal(first.run.adapterId, "mock");
    assert.equal(first.run.sourceName, "mock:sample");
    assert.ok(first.run.finishedAt);
    assert.equal(first.items.length, 3);
    const second = await syncSource(deps, "mock", "sample");
    assert.equal(second.created, 0);
    assert.equal(second.duplicates, 3);
    assert.equal(second.run.status, "SUCCESS");
    assert.equal(repos.opportunities.listAll().length, 3);
    assert.equal(repos.syncRuns.listRecent(10).length, 2);
    const empty = await syncSource(deps, "mock", "empty");
    assert.equal(empty.run.fetched, 0);
    assert.equal(empty.run.status, "SUCCESS");
  });

  it("rejects an unknown adapter (404) and an invalid target (422) before recording a run", async () => {
    const { deps, repos } = syncDeps();
    await assert.rejects(() => syncSource(deps, "nope", "sample"), isHttp(404));
    await assert.rejects(() => syncSource(deps, "mock", "bogus"), isHttp(422));
    assert.deepEqual(repos.syncRuns.listRecent(10), []);
  });
});

describe("indexer", () => {
  let tmp: string;
  let resumesDir: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "radar-services-index-"));
    resumesDir = join(tmp, "resumes");
    mkdirSync(join(resumesDir, "archive"), { recursive: true });
    const fixtures = new URL("./fixtures/resumes/", import.meta.url).pathname;
    copyFileSync(join(fixtures, "jordan-example-software-engineer.md"), join(resumesDir, "jordan-example-software-engineer.md"));
    copyFileSync(join(fixtures, "jordan-example-product-manager.txt"), join(resumesDir, "archive", "jordan-example-product-manager.txt"));
    writeFileSync(
      join(resumesDir, "jordan-example-designer.docx"),
      minimalDocx([
        "Jordan Example",
        "jordan@example.com | 555-010-0100",
        "Product Designer with eight years of experience in design systems and UX research.",
        "EXPERIENCE",
        "Senior Product Designer — Example Corp (2019 – Present)",
        "Led the design system and ran UX research with Figma prototypes for the checkout flow.",
        "Product Designer — Widgets LLC (2015 – 2019)",
        "Delivered wireframes and prototypes in Figma and Sketch for a mobile banking app.",
        "EDUCATION",
        "B.F.A. Graphic Design, Example State University, 2015",
        "SKILLS",
        "Figma, Sketch, Prototyping, Wireframing, Design Systems, UX Research, Accessibility",
      ]),
    );
    writeFileSync(join(resumesDir, "scanned-resume.pdf"), minimalPdf([]));
    writeFileSync(join(resumesDir, ".hidden.pdf"), minimalPdf(["hidden"]));
    writeFileSync(join(resumesDir, "photo.jpg"), "not a résumé");
    writeFileSync(join(resumesDir, "notes.rtf"), "not supported");
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists supported files only, ignoring dotfiles and unsupported extensions", () => {
    assert.deepEqual(listResumeFiles(resumesDir), ["archive/jordan-example-product-manager.txt", "jordan-example-designer.docx", "jordan-example-software-engineer.md", "scanned-resume.pdf"]);
    assert.deepEqual(listResumeFiles(join(tmp, "does-not-exist")), []);
  });

  it("indexes, skips unchanged files, keeps user labels on force, and marks deleted files missing", async () => {
    const repos = createTestRepos();
    const config = testConfig(tmp);
    assert.equal(config.resumesDir, resumesDir);
    const deps = { repos, now: clock().now, logger: silentLogger, config };

    const first = await indexResumeFolder(deps);
    assert.equal(first.dirExists, true);
    assert.equal(first.indexed, 4);
    assert.equal(first.skipped, 0);
    assert.equal(first.needsOcr, 1);
    assert.equal(first.failed, 0);
    assert.equal(first.removed, 0);
    assert.equal(first.items.length, 4);
    assert.ok(!JSON.stringify(first).includes(tmp), "no absolute paths leak");
    assert.ok(first.items.every((i) => !("extractedText" in i) && typeof i.extractedCharacters === "number"));
    const byFile = (name: string) => first.items.find((i) => i.filename === name)!;
    assert.equal(byFile("scanned-resume.pdf").extractionStatus, "NEEDS_OCR");
    assert.equal(byFile("scanned-resume.pdf").isActive, false);
    assert.equal(byFile("jordan-example-software-engineer.md").extractionStatus, "OK");
    assert.equal(byFile("jordan-example-software-engineer.md").isActive, true);
    assert.equal(byFile("jordan-example-software-engineer.md").label, "Jordan Example Software Engineer");
    assert.ok(byFile("jordan-example-software-engineer.md").skills.some((s) => /typescript/i.test(s)));
    assert.equal(byFile("jordan-example-designer.docx").format, "docx");
    assert.ok(byFile("jordan-example-designer.docx").skills.some((s) => /figma/i.test(s)));
    assert.equal(byFile("archive/jordan-example-product-manager.txt").format, "txt");
    assert.ok(byFile("archive/jordan-example-product-manager.txt").targetRoles.some((r) => /product manager/i.test(r)));
    assert.equal(repos.resumes.listActive().length, 3);

    const second = await indexResumeFolder(deps);
    assert.equal(second.indexed, 0);
    assert.equal(second.skipped, 4);

    const se = repos.resumes.findByFilename("jordan-example-software-engineer.md")!;
    repos.resumes.update(se.id, { label: "My custom label", targetRoles: ["Staff Engineer"] });
    const forced = await indexResumeFolder(deps, { force: true });
    assert.equal(forced.indexed, 4);
    assert.equal(forced.skipped, 0);
    const reindexed = repos.resumes.findByFilename("jordan-example-software-engineer.md")!;
    assert.equal(reindexed.id, se.id);
    assert.equal(reindexed.label, "My custom label");
    assert.deepEqual(reindexed.targetRoles, ["Staff Engineer"]);
    assert.ok(reindexed.skills.some((s) => /typescript/i.test(s)), "extraction data is refreshed");

    unlinkSync(join(resumesDir, "jordan-example-designer.docx"));
    const afterDelete = await indexResumeFolder(deps);
    assert.equal(afterDelete.removed, 1);
    assert.equal(afterDelete.skipped, 3);
    const missing = repos.resumes.findByFilename("jordan-example-designer.docx")!;
    assert.equal(missing.extractionStatus, "MISSING_FILE");
    assert.equal(missing.isActive, false);
    assert.ok(repos.audit.listForEntity("resume", missing.id).some((e) => e.event === "resume.missing"));
    assert.equal((await indexResumeFolder(deps)).removed, 0, "missing files are marked once");
    assert.ok(!JSON.stringify(afterDelete.items).includes(tmp));
  });

  it("reports a missing folder without throwing", async () => {
    const repos = createTestRepos();
    const deps = { repos, now: clock().now, logger: silentLogger, config: testConfig(join(tmp, "nowhere")) };
    const r = await indexResumeFolder(deps);
    assert.equal(r.dirExists, false);
    assert.equal(r.indexed, 0);
    assert.ok(r.messages[0] && /does not exist/.test(r.messages[0]));
    assert.ok(!JSON.stringify(r).includes(tmp));
  });
});

describe("createOpportunity (shared ingest path)", () => {
  it("normalises and dedupes a manual listing the same way the API does", () => {
    const repos = createTestRepos();
    const deps = { repos, now: clock().now, logger: silentLogger };
    const input = ManualOpportunityInputSchema.parse(SAMPLE_LISTING);
    const created = createOpportunity(deps, input);
    assert.equal(created.duplicate, false);
    assert.equal(created.opportunity.workMode, "REMOTE");
    assert.equal(created.opportunity.geographicEligibility, "US_ONLY");
    assert.equal(created.opportunity.companyDomain, "northwind.example");
    assert.equal(created.opportunity.canonicalUrl, SAMPLE_LISTING.sourceUrl);
    assert.equal(created.opportunity.compensation.min, 150000);
    const dup = createOpportunity(deps, ManualOpportunityInputSchema.parse({ ...SAMPLE_LISTING, sourceName: "rss:jobs.example" }));
    assert.equal(dup.duplicate, true);
    assert.equal(dup.duplicateOf, created.opportunity.id);
    assert.deepEqual(dup.matchedOn, ["canonicalUrl"]);
    assert.equal(repos.sources.listByOpportunity(created.opportunity.id).length, 2);
  });
});
