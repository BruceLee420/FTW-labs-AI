/**
 * End-to-end: create a manual opportunity through the HTTP API and move it
 * through review → draft → approval → applied → follow-up → export.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHarness, SAMPLE_LISTING, SCAM_LISTING, type Harness } from "./helpers/harness.ts";

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

function seedResume(label = "Jordan Example Software Engineer") {
  const now = new Date().toISOString();
  return h.deps.repos.resumes.upsertByFilename({
    id: "resume-se",
    filename: "jordan-example-software-engineer.md",
    format: "md",
    label,
    targetRoles: ["Software Engineer"],
    skills: ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Docker"],
    industries: ["Logistics"],
    experienceSummary: "Senior Software Engineer — Northwind Analytics (2020 – Present); Software Engineer — Contoso Freight (2017 – 2020)",
    educationSummary: "B.S. Computer Science, Example State University, 2017",
    verifiedFacts: [
      { kind: "role", text: "Senior Software Engineer — Northwind Analytics" },
      { kind: "degree", text: "B.S. Computer Science" },
      { kind: "date-range", text: "2020 – Present" },
    ],
    extractedText:
      "Jordan Example\njordan@example.com\nSenior Software Engineer — Northwind Analytics (2020 – Present)\nBuilt TypeScript services on Node.js with PostgreSQL on AWS using Docker.\nSoftware Engineer — Contoso Freight (2017 – 2020)\nEducation\nB.S. Computer Science, Example State University, 2017",
    extractionStatus: "OK",
    extractionQuality: 90,
    extractionNotes: [],
    contentHash: "abc",
    fileSize: 1000,
    fileModifiedAt: now,
    lastIndexedAt: now,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
}

test("health is public and never exposes paths", async () => {
  const res = await fetch(`${h.base}/api/opportunity-radar/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.ai.reachable, "boolean");
  assert.ok(!JSON.stringify(body).includes("/tmp/"), "health must not leak filesystem paths");
});

test("manual opportunity: create → rules+AI evaluate → recommend résumé → draft → approve → applied → follow-up → export", async () => {
  seedResume();
  h.ai.responses.push({
    legitimacyScore: 85,
    scamRiskScore: 5,
    relevanceScore: 88,
    remoteEligibilityScore: 90,
    bestResumeId: "resume-se",
    rationale: "Official ATS listing with a complete description and consistent domain.",
    evidence: [{ claim: "Fully remote in the US", reference: "fully remote role open to candidates located in the United States" }],
    riskSignals: [],
    missingInformation: [],
    suggestedNextAction: "Apply with Jordan Example Software Engineer",
    confidence: "high",
  });

  const created = await h.api("opportunities/manual", { body: SAMPLE_LISTING });
  assert.equal(created.status, 201, created.text);
  const o = created.data.opportunity;
  assert.equal(created.data.duplicate, false);
  assert.equal(o.workMode, "REMOTE");
  assert.equal(o.geographicEligibility, "US_ONLY");
  assert.ok(o.requiredSkills.some((s: string) => /typescript/i.test(s)), `skills: ${o.requiredSkills}`);
  assert.ok(o.responsibilities.length >= 3);
  assert.ok(o.qualifications.length >= 3);
  assert.equal(o.compensation.min, 150000);
  assert.equal(o.compensation.currency, "USD");
  assert.ok(["VERIFIED_OFFICIAL_SOURCE", "LIKELY_LEGIT"].includes(o.verificationStatus), o.verificationStatus);
  assert.equal(o.status, "VERIFIED");
  assert.equal(o.recommendedResumeId, "resume-se");
  assert.ok(o.legitimacyScore >= 65 && o.scamRiskScore < 30, `legit ${o.legitimacyScore} scam ${o.scamRiskScore}`);
  assert.ok(o.relevanceScore !== null && o.relevanceScore > 50, `relevance ${o.relevanceScore}`);
  assert.ok(o.verificationReasons.length > 0);
  const evaluation = created.data.evaluation;
  assert.equal(evaluation.aiStatus, "OK");
  assert.equal(evaluation.promptVersion, "evaluate-v1");
  assert.equal(evaluation.model, "fake-model");
  const sentPrompt = h.ai.calls[0]!.prompt;
  assert.ok(sentPrompt.includes("resume-se"), "candidate résumé id is offered to the model");
  assert.ok(!sentPrompt.includes("jordan@example.com"), "contact details are not sent to the model in evaluation");

  // Duplicate sighting keeps the original.
  const dup = await h.api("opportunities/manual", { body: { ...SAMPLE_LISTING, sourceName: "rss:jobs.example" } });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.duplicate, true);
  assert.equal(dup.data.duplicateOf, o.id);
  const detail = await h.api(`opportunities/${o.id}`);
  assert.equal(detail.data.sources.length, 2);

  // Applying before approval is refused.
  const early = await h.api(`opportunities/${o.id}/mark-applied`, { body: {} });
  assert.equal(early.status, 409);

  // Draft package from the model, grounded against the résumé.
  h.ai.responses.push({
    professionalSummary: "Senior Software Engineer with TypeScript and Node.js experience at Northwind Analytics.",
    coverLetter: "Dear team, I built TypeScript services on Node.js with PostgreSQL on AWS. Sincerely, Jordan",
    resumeTailoringSuggestions: ["Lead with PostgreSQL performance work."],
    applicationAnswers: [{ question: "Why us?", answer: "Because of the distributed team." }],
    recruiterOutreach: null,
    evidence: [
      { claim: "TypeScript services on Node.js", sourceFact: "Built TypeScript services on Node.js with PostgreSQL on AWS using Docker." },
      { claim: "Led a platform migration at Fabrikam", sourceFact: "Platform migration lead at Fabrikam 2015" },
    ],
  });
  const drafted = await h.api(`opportunities/${o.id}/generate-draft`, { body: { questions: ["Why us?"] } });
  assert.equal(drafted.status, 201, drafted.text);
  const draft = drafted.data.draft;
  assert.equal(draft.kind, "APPLICATION_PACKAGE");
  assert.equal(draft.version, 1);
  assert.equal(draft.generatedBy, "ai");
  assert.equal(draft.promptVersion, "draft-v1");
  assert.equal(draft.content.evidence[0].grounded, true);
  assert.equal(draft.content.evidence[1].grounded, false, "invented fact is flagged");
  assert.ok(draft.groundingWarnings.length === 1);
  assert.equal(drafted.data.opportunity.status, "DRAFT_PREPARED");
  const draftPrompt = h.ai.calls[1]!.prompt;
  assert.ok(draftPrompt.includes("Northwind Analytics") && draftPrompt.includes("PostgreSQL"), "draft prompt carries résumé facts");

  // User edits produce a new version.
  const edited = await h.api(`opportunities/${o.id}/drafts/${draft.id}`, { method: "PATCH", body: { coverLetter: "Edited letter." } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.data.draft.version, 2);
  assert.equal(edited.data.draft.generatedBy, "user");

  // Approve explicitly.
  const bad = await h.api(`opportunities/${o.id}/approve`, { body: { acknowledged: false } });
  assert.equal(bad.status, 400);
  const approved = await h.api(`opportunities/${o.id}/approve`, { body: { acknowledged: true, draftVersion: 2 } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.data.application.status, "APPROVED");
  assert.equal(approved.data.application.approvedDraftVersion, 2);
  assert.equal(approved.data.opportunity.status, "READY_TO_APPLY");
  assert.ok(approved.data.checklist.length >= 3);
  assert.equal(approved.data.applicationUrl, SAMPLE_LISTING.applicationUrl);

  // Mark applied → follow-up scheduled 7 days later by default.
  const applied = await h.api(`opportunities/${o.id}/mark-applied`, { body: { appliedAt: "2026-09-01T12:00:00Z", confirmationReference: "REQ-42" } });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.data.application.status, "SUBMITTED");
  assert.equal(applied.data.application.confirmationReference, "REQ-42");
  assert.equal(applied.data.application.followUpDueAt, "2026-09-08T12:00:00.000Z");
  assert.equal(applied.data.followUp.status, "PENDING");
  assert.equal(applied.data.opportunity.status, "APPLIED");

  // Reschedule with an explicit interval (0 days = due on the application date, which is in the past).
  const resched = await h.api(`opportunities/${o.id}/schedule-follow-up`, { body: { days: 0 } });
  assert.equal(resched.status, 200, resched.text);
  assert.equal(resched.data.followUp.dueAt, "2026-09-01T12:00:00.000Z");

  // Follow-up is due → status promoted to FOLLOW_UP_DUE when listing.
  const list = await h.api("opportunities?status=FOLLOW_UP_DUE");
  assert.equal(list.status, 200);
  assert.equal(list.data.total, 1);
  assert.equal(list.data.items[0].id, o.id);
  assert.ok(!("rawDescription" in list.data.items[0]));

  const summary = await h.api("summary");
  assert.equal(summary.data.counts.followUpsDue, 1);

  // Follow-up email is drafted, never sent.
  h.ai.responses.push({ subject: "Following up", body: "Hello, following up on REQ-42.", evidence: [] });
  const fu = await h.api(`opportunities/${o.id}/follow-up-draft`, { body: {} });
  assert.equal(fu.status, 201, fu.text);
  assert.equal(fu.data.draft.kind, "FOLLOW_UP_EMAIL");
  const done = await h.api(`opportunities/${o.id}/complete-follow-up`, { body: { sentAt: "2026-09-05T09:00:00Z" } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.data.opportunity.status, "FOLLOWED_UP");
  assert.equal(done.data.application.followUpSentAt, "2026-09-05T09:00:00.000Z");

  // Status change + note + audit trail.
  const st = await h.api(`opportunities/${o.id}/status`, { body: { status: "INTERVIEWING", note: "Phone screen booked" } });
  assert.equal(st.data.opportunity.status, "INTERVIEWING");
  const note = await h.api(`opportunities/${o.id}/notes`, { body: { note: "Recruiter: Sam" } });
  assert.ok(note.data.opportunity.notes.includes("Recruiter: Sam"));
  const full = await h.api(`opportunities/${o.id}`);
  const events = full.data.audit.map((e: any) => e.event);
  for (const expected of ["opportunity.created", "opportunity.evaluated", "status.changed", "note.added", "opportunity.duplicate_sighting"]) {
    assert.ok(events.includes(expected), `audit has ${expected}: ${events}`);
  }
  assert.ok(full.data.drafts.length >= 3);
  assert.equal(full.data.recommendedResume.label, "Jordan Example Software Engineer");
  assert.ok(!("extractedText" in full.data.recommendedResume));

  // CSV export has the fixed columns and the row.
  const csvRes = await fetch(`${h.base}/api/opportunity-radar/export.csv`, { headers: { "X-Radar-Request": "1" } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await csvRes.text();
  const header = csv.split(/\r?\n/)[0];
  assert.equal(header, "Company Name,Position Title,Employment Type,Work Mode,Location / Eligibility,Source Name,Source URL,Application URL,Date Found,Date Posted,Verification Status,Legitimacy Score,Scam Risk Score,Relevance Score,Recommended Résumé,Date Applied,Follow-Up Due Date,Follow-Up Sent Date,Current Status,Notes");
  assert.ok(csv.includes("Northwind Analytics") && csv.includes("2026-09-01") && csv.includes("2026-09-05") && csv.includes("INTERVIEWING"));
});

test("scam listing is flagged high risk with explainable signals; drafting is blocked after rejection", async () => {
  h.ai.reachable = false;
  const created = await h.api("opportunities/manual", { body: SCAM_LISTING });
  assert.equal(created.status, 201, created.text);
  const o = created.data.opportunity;
  assert.equal(o.verificationStatus, "HIGH_RISK");
  assert.equal(o.status, "REVIEW_NEEDED");
  assert.ok(o.scamRiskScore >= 70, `scam risk ${o.scamRiskScore}`);
  const codes = o.scamSignals.map((s: any) => s.code);
  for (const code of ["REQUESTS_PAYMENT", "MESSAGING_APP_ONLY", "GENERIC_WEBMAIL_CONTACT", "SENSITIVE_DATA_REQUEST", "HIRING_PRESSURE", "SUSPICIOUS_REDIRECT"]) {
    assert.ok(codes.includes(code), `expected ${code} in ${codes}`);
  }
  assert.ok(o.scamSignals.every((s: any) => s.message && typeof s.weight === "number"));
  assert.equal(created.data.evaluation.aiStatus, "UNAVAILABLE", "AI offline is recorded, not fatal");
  assert.ok(o.verificationReasons.some((r: string) => /high risk/i.test(r)));
  assert.ok(!o.verificationReasons.some((r: string) => /\bsafe\b/i.test(r)), "never says 'safe'");

  const rejected = await h.api(`opportunities/${o.id}/status`, { body: { status: "REJECTED" } });
  assert.equal(rejected.data.opportunity.verificationStatus, "REJECTED_AS_SCAM");
  const draft = await h.api(`opportunities/${o.id}/generate-draft`, { body: {} });
  assert.equal(draft.status, 409);
  h.ai.reachable = true;
});

test("template draft works with AI disabled and is grounded by construction", async () => {
  seedResume();
  h.ai.reachable = false;
  const created = await h.api("opportunities/manual", { body: { ...SAMPLE_LISTING, title: "Staff Engineer", rawDescription: SAMPLE_LISTING.rawDescription + "\nStaff-level scope: you will set technical direction across teams.", sourceUrl: "https://northwind.example/careers/staff", applicationUrl: "https://northwind.example/careers/staff", evaluate: false } });
  assert.equal(created.status, 201, created.text);
  const id = created.data.opportunity.id;
  const evaluated = await h.api(`opportunities/${id}/evaluate`, { body: { rulesOnly: true } });
  assert.equal(evaluated.data.evaluation.aiStatus, "DISABLED");
  assert.equal(evaluated.data.opportunity.recommendedResumeId, "resume-se");
  const drafted = await h.api(`opportunities/${id}/generate-draft`, { body: { templateOnly: true, includeOutreach: true } });
  assert.equal(drafted.status, 201, drafted.text);
  const d = drafted.data.draft;
  assert.equal(d.generatedBy, "template");
  assert.ok(d.content.coverLetter.includes("Staff Engineer"));
  assert.ok(d.content.recruiterOutreach);
  assert.ok(d.content.evidence.length > 0 && d.content.evidence.every((e: any) => e.grounded), JSON.stringify(d.content.evidence));
  assert.ok(!/Fabrikam|MBA|Ph\.D/.test(JSON.stringify(d.content)), "template never invents");
  h.ai.reachable = true;
});

test("deletion and purge remove data; purge requires the typed confirmation", async () => {
  const created = await h.api("opportunities/manual", { body: { companyName: "Temp Co", title: "Temp role", rawDescription: "Short description of a temporary role for testing deletion.", evaluate: false } });
  const id = created.data.opportunity.id;
  const del = await h.api(`opportunities/${id}`, { method: "DELETE" });
  assert.equal(del.status, 204);
  assert.equal((await h.api(`opportunities/${id}`)).status, 404);
  const wrong = await h.api("data/purge", { body: { confirm: "yes", scope: "all" } });
  assert.equal(wrong.status, 400);
  const purged = await h.api("data/purge", { body: { confirm: "DELETE EVERYTHING", scope: "all" } });
  assert.equal(purged.status, 200, purged.text);
  assert.equal((await h.api("opportunities")).data.total, 0);
  assert.equal((await h.api("resumes")).data.items.length, 0);
});
