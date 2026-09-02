/**
 * Test-only database helpers: an in-memory SQLite with every migration
 * applied, repositories wired to it, and synthetic fixture builders.
 *
 * Why: every repository/service test needs the same three things and must
 * never touch a real database file. Fixtures use placeholder people and
 * companies only ("Jordan Example", "Example Corp") — no real data.
 */
import type { Db } from "../../src/db/client.ts";
import { openDatabase } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import type { Repositories } from "../../src/repositories/interfaces.ts";
import { createSqliteRepositories } from "../../src/repositories/sqlite/index.ts";
import type {
  Application,
  ApplicationDraft,
  AuditEvent,
  Evaluation,
  FollowUpTask,
  Opportunity,
  OpportunitySource,
  ResumeProfile,
  SourceSyncRun,
} from "../../src/types/entities.ts";
import { newId } from "../../src/utils/ids.ts";
import { shortHash } from "../../src/utils/hash.ts";
import { nowIso } from "../../src/utils/time.ts";

/** A stable timestamp fixtures default to, so ordering tests are deterministic. */
export const FIXED_NOW = "2026-09-01T10:00:00.000Z";

/** Fresh in-memory database with the schema applied. */
export function createTestDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

/** Repositories over a fresh (or supplied) in-memory database. */
export function createTestRepos(db: Db = createTestDb(), now: () => string = nowIso): Repositories {
  return createSqliteRepositories(db, { now });
}

export function buildOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const id = overrides.id ?? newId();
  return {
    id,
    sourceName: "manual",
    sourceType: "MANUAL_URL",
    sourceUrl: null,
    canonicalUrl: null,
    applicationUrl: null,
    externalId: null,
    companyName: "Example Corp",
    companyDomain: null,
    companyWebsite: null,
    officialCareerUrl: null,
    title: "Software Engineer",
    employmentType: "FULL_TIME",
    workMode: "REMOTE",
    locationText: null,
    geographicEligibility: "GLOBAL",
    eligibleCountries: [],
    timezoneRequirements: null,
    rawDescription: "Synthetic description for tests.",
    normalizedDescription: "Synthetic description for tests.",
    descriptionHash: shortHash(id),
    responsibilities: [],
    qualifications: [],
    requiredSkills: [],
    preferredSkills: [],
    compensation: { text: null, min: null, max: null, currency: null, period: "UNKNOWN" },
    postedAt: null,
    discoveredAt: FIXED_NOW,
    closesAt: null,
    relevanceScore: null,
    legitimacyScore: null,
    scamRiskScore: null,
    remoteEligibilityScore: null,
    verificationStatus: "UNVERIFIED",
    verificationReasons: [],
    scamSignals: [],
    status: "DISCOVERED",
    recommendedResumeId: null,
    matchRationale: null,
    nextAction: null,
    followUpDueAt: null,
    notes: "",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function buildSource(opportunityId: string, overrides: Partial<OpportunitySource> = {}): OpportunitySource {
  return {
    id: newId(),
    opportunityId,
    sourceName: "manual",
    sourceType: "MANUAL_URL",
    sourceUrl: null,
    externalId: null,
    seenAt: FIXED_NOW,
    descriptionHash: null,
    ...overrides,
  };
}

export function buildEvaluation(opportunityId: string, overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    id: newId(),
    opportunityId,
    createdAt: FIXED_NOW,
    promptVersion: "eval-v1",
    provider: "none",
    model: null,
    aiStatus: "DISABLED",
    aiError: null,
    rules: {
      legitimacyScore: 60,
      scamRiskScore: 20,
      remoteEligibilityScore: 80,
      relevanceScore: null,
      verificationStatus: "UNVERIFIED",
      signals: [],
      reasons: ["synthetic"],
      missingInformation: [],
    },
    ai: null,
    candidateResumeIds: [],
    recommendedResumeId: null,
    matchRationale: null,
    ...overrides,
  };
}

export function buildResume(overrides: Partial<ResumeProfile> = {}): ResumeProfile {
  return {
    id: newId(),
    filename: "jordan-example-engineer.pdf",
    format: "pdf",
    label: "Jordan Example — Engineer",
    targetRoles: ["Software Engineer"],
    skills: ["TypeScript"],
    industries: ["Software"],
    experienceSummary: "Synthetic experience summary.",
    educationSummary: "Synthetic education summary.",
    verifiedFacts: [{ kind: "employer", text: "Example Corp" }],
    extractedText: "Jordan Example. Software engineer at Example Corp.",
    extractionStatus: "OK",
    extractionQuality: 80,
    extractionNotes: [],
    contentHash: "hash-1",
    fileSize: 1234,
    fileModifiedAt: FIXED_NOW,
    lastIndexedAt: FIXED_NOW,
    isActive: true,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function buildApplication(opportunityId: string, overrides: Partial<Application> = {}): Application {
  return {
    id: newId(),
    opportunityId,
    resumeId: null,
    status: "DRAFTING",
    currentDraftVersion: 0,
    approvedAt: null,
    approvedDraftVersion: null,
    appliedAt: null,
    confirmationReference: null,
    followUpDueAt: null,
    followUpSentAt: null,
    notes: "",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function buildDraft(
  applicationId: string,
  opportunityId: string,
  overrides: Partial<ApplicationDraft> = {},
): ApplicationDraft {
  return {
    id: newId(),
    applicationId,
    opportunityId,
    resumeId: null,
    kind: "APPLICATION_PACKAGE",
    version: 1,
    content: {
      professionalSummary: "Synthetic summary.",
      coverLetter: "Synthetic cover letter.",
      resumeTailoringSuggestions: [],
      applicationAnswers: [],
      recruiterOutreach: null,
      evidence: [],
    },
    groundingWarnings: [],
    generatedBy: "template",
    provider: null,
    model: null,
    promptVersion: null,
    createdAt: FIXED_NOW,
    editedAt: null,
    ...overrides,
  };
}

export function buildFollowUp(opportunityId: string, overrides: Partial<FollowUpTask> = {}): FollowUpTask {
  return {
    id: newId(),
    opportunityId,
    applicationId: null,
    dueAt: FIXED_NOW,
    status: "PENDING",
    note: "",
    draftId: null,
    completedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function buildSyncRun(overrides: Partial<SourceSyncRun> = {}): SourceSyncRun {
  return {
    id: newId(),
    adapterId: "greenhouse",
    sourceName: "greenhouse:example",
    startedAt: FIXED_NOW,
    finishedAt: null,
    status: "RUNNING",
    fetched: 0,
    created: 0,
    duplicates: 0,
    errors: [],
    ...overrides,
  };
}

export function buildAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: newId(),
    entityType: "opportunity",
    entityId: "opp-1",
    event: "created",
    detail: {},
    actor: "user",
    createdAt: FIXED_NOW,
    ...overrides,
  };
}
