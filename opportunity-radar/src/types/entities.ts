/**
 * Opportunity Radar — core entity types.
 *
 * These are the shapes stored by the repositories and returned by the API.
 * Enumerations are plain string-literal unions (not TS enums) so the module
 * runs under Node's native type stripping and stays JSON-friendly.
 *
 * Anything marked "server only" must never be included in a browser response.
 */

export const SOURCE_TYPES = ["OFFICIAL_ATS", "JOB_BOARD", "MANUAL_URL", "RSS", "REFERRAL"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const WORK_MODES = ["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACT",
  "TEMPORARY",
  "INTERNSHIP",
  "FREELANCE",
  "UNKNOWN",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const GEOGRAPHIC_ELIGIBILITIES = [
  "US_ONLY",
  "US_SPECIFIC_STATES",
  "GLOBAL",
  "COUNTRY_RESTRICTED",
  "UNKNOWN",
] as const;
export type GeographicEligibility = (typeof GEOGRAPHIC_ELIGIBILITIES)[number];

export const VERIFICATION_STATUSES = [
  "UNVERIFIED",
  "LIKELY_LEGIT",
  "VERIFIED_OFFICIAL_SOURCE",
  "NEEDS_MANUAL_REVIEW",
  "HIGH_RISK",
  "REJECTED_AS_SCAM",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const OPPORTUNITY_STATUSES = [
  "DISCOVERED",
  "NORMALIZED",
  "REVIEW_NEEDED",
  "VERIFIED",
  "READY_TO_APPLY",
  "DRAFT_PREPARED",
  "AWAITING_APPROVAL",
  "APPLIED",
  "FOLLOW_UP_DUE",
  "FOLLOWED_UP",
  "INTERVIEWING",
  "OFFER",
  "REJECTED",
  "SKIPPED",
  "CLOSED",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const COMPENSATION_PERIODS = ["YEAR", "MONTH", "WEEK", "DAY", "HOUR", "UNKNOWN"] as const;
export type CompensationPeriod = (typeof COMPENSATION_PERIODS)[number];

/** ISO-8601 timestamp string (UTC). */
export type IsoDateTime = string;

export interface Compensation {
  text: string | null;
  min: number | null;
  max: number | null;
  currency: string | null;
  period: CompensationPeriod;
}

/** A deterministic or model-derived risk/positive signal with its evidence. */
export interface Signal {
  /** Stable machine id, e.g. "REQUESTS_PAYMENT". */
  code: string;
  /** "risk" lowers legitimacy; "positive" raises it; "info" is neutral. */
  kind: "risk" | "positive" | "info";
  /** Points applied to the relevant score (positive numbers; sign by kind). */
  weight: number;
  /** Human-readable explanation shown in the UI. */
  message: string;
  /** Short quote or field reference that triggered the signal. */
  evidence: string | null;
}

export interface Opportunity {
  id: string;
  sourceName: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  applicationUrl: string | null;
  externalId: string | null;

  companyName: string;
  companyDomain: string | null;
  companyWebsite: string | null;
  officialCareerUrl: string | null;

  title: string;
  employmentType: EmploymentType;
  workMode: WorkMode;
  locationText: string | null;
  geographicEligibility: GeographicEligibility;
  eligibleCountries: string[];
  timezoneRequirements: string | null;

  rawDescription: string;
  normalizedDescription: string;
  descriptionHash: string;
  responsibilities: string[];
  qualifications: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  compensation: Compensation;

  postedAt: IsoDateTime | null;
  discoveredAt: IsoDateTime;
  closesAt: IsoDateTime | null;

  relevanceScore: number | null;
  legitimacyScore: number | null;
  scamRiskScore: number | null;
  remoteEligibilityScore: number | null;

  verificationStatus: VerificationStatus;
  verificationReasons: string[];
  scamSignals: Signal[];

  status: OpportunityStatus;
  recommendedResumeId: string | null;
  matchRationale: string | null;
  nextAction: string | null;
  followUpDueAt: IsoDateTime | null;
  notes: string;

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Evidence that a listing was seen at a given source; one row per sighting. */
export interface OpportunitySource {
  id: string;
  opportunityId: string;
  sourceName: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  externalId: string | null;
  seenAt: IsoDateTime;
  descriptionHash: string | null;
}

export const AI_STATUSES = ["OK", "UNAVAILABLE", "INVALID_OUTPUT", "ERROR", "DISABLED"] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

/** Deterministic rules result, always present. */
export interface RuleEvaluation {
  legitimacyScore: number;
  scamRiskScore: number;
  remoteEligibilityScore: number;
  relevanceScore: number | null;
  verificationStatus: VerificationStatus;
  signals: Signal[];
  reasons: string[];
  missingInformation: string[];
}

/** Validated model output for the advisory evaluation. Mirrors schemas/ai.ts. */
export interface AiEvaluation {
  legitimacyScore: number;
  scamRiskScore: number;
  relevanceScore: number;
  remoteEligibilityScore: number;
  bestResumeId: string | null;
  rationale: string;
  evidence: { claim: string; reference: string }[];
  riskSignals: string[];
  missingInformation: string[];
  suggestedNextAction: string;
  confidence: "low" | "medium" | "high";
}

export interface Evaluation {
  id: string;
  opportunityId: string;
  createdAt: IsoDateTime;
  promptVersion: string | null;
  provider: string;
  model: string | null;
  aiStatus: AiStatus;
  aiError: string | null;
  rules: RuleEvaluation;
  ai: AiEvaluation | null;
  /** Ids of résumé profiles offered to the model (metadata only was sent). */
  candidateResumeIds: string[];
  recommendedResumeId: string | null;
  matchRationale: string | null;
}

export const EXTRACTION_STATUSES = ["OK", "POOR", "NEEDS_OCR", "FAILED", "UNSUPPORTED", "MISSING_FILE"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const RESUME_FORMATS = ["pdf", "docx", "txt", "md"] as const;
export type ResumeFormat = (typeof RESUME_FORMATS)[number];

export interface VerifiedFact {
  /** e.g. "employer", "role", "degree", "certification", "date-range", "skill", "contact" */
  kind: string;
  text: string;
}

export interface ResumeProfile {
  id: string;
  /** Path relative to the résumé root. Never an absolute path. */
  filename: string;
  format: ResumeFormat;
  label: string;
  targetRoles: string[];
  skills: string[];
  industries: string[];
  experienceSummary: string;
  educationSummary: string;
  verifiedFacts: VerifiedFact[];
  /** Server only. Never serialised to the browser. */
  extractedText: string;
  extractionStatus: ExtractionStatus;
  /** 0–100 heuristic on how usable the extracted text is. */
  extractionQuality: number;
  extractionNotes: string[];
  contentHash: string;
  fileSize: number;
  fileModifiedAt: IsoDateTime | null;
  lastIndexedAt: IsoDateTime;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The browser-safe projection of a résumé profile. */
export type ResumeProfileSummary = Omit<ResumeProfile, "extractedText"> & {
  extractedCharacters: number;
};

export const APPLICATION_STATUSES = [
  "DRAFTING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SUBMITTED",
  "WITHDRAWN",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface Application {
  id: string;
  opportunityId: string;
  resumeId: string | null;
  status: ApplicationStatus;
  currentDraftVersion: number;
  approvedAt: IsoDateTime | null;
  approvedDraftVersion: number | null;
  appliedAt: IsoDateTime | null;
  confirmationReference: string | null;
  followUpDueAt: IsoDateTime | null;
  followUpSentAt: IsoDateTime | null;
  notes: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const DRAFT_KINDS = ["APPLICATION_PACKAGE", "FOLLOW_UP_EMAIL"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export interface DraftEvidence {
  /** The statement made in the draft. */
  claim: string;
  /** The résumé fact (verbatim or near-verbatim) that supports it. */
  sourceFact: string;
  resumeId: string;
  /** False when the grounding check could not find the fact in the résumé. */
  grounded: boolean;
}

export interface ApplicationAnswer {
  question: string;
  answer: string;
}

/** Mirrors schemas/ai.ts DraftPackageSchema. */
export interface DraftPackage {
  professionalSummary: string;
  coverLetter: string;
  resumeTailoringSuggestions: string[];
  applicationAnswers: ApplicationAnswer[];
  recruiterOutreach: string | null;
  evidence: DraftEvidence[];
}

export interface FollowUpEmailDraft {
  subject: string;
  body: string;
  evidence: DraftEvidence[];
}

export interface ApplicationDraft {
  id: string;
  applicationId: string;
  opportunityId: string;
  resumeId: string | null;
  kind: DraftKind;
  version: number;
  content: DraftPackage | FollowUpEmailDraft;
  groundingWarnings: string[];
  generatedBy: "ai" | "template" | "user";
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: IsoDateTime;
  editedAt: IsoDateTime | null;
}

export const FOLLOW_UP_STATUSES = ["PENDING", "DONE", "CANCELLED"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export interface FollowUpTask {
  id: string;
  opportunityId: string;
  applicationId: string | null;
  dueAt: IsoDateTime;
  status: FollowUpStatus;
  note: string;
  draftId: string | null;
  completedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const SYNC_RUN_STATUSES = ["RUNNING", "SUCCESS", "PARTIAL", "FAILED"] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export interface SourceSyncRun {
  id: string;
  adapterId: string;
  sourceName: string;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  status: SyncRunStatus;
  fetched: number;
  created: number;
  duplicates: number;
  errors: string[];
}

export interface AuditEvent {
  id: string;
  entityType: "opportunity" | "resume" | "application" | "draft" | "follow_up" | "sync_run" | "system";
  entityId: string;
  event: string;
  detail: Record<string, unknown>;
  actor: string;
  createdAt: IsoDateTime;
}

/** Opportunity plus the derived rows the list/detail views need. */
export interface OpportunityDetail {
  opportunity: Opportunity;
  sources: OpportunitySource[];
  latestEvaluation: Evaluation | null;
  application: Application | null;
  drafts: ApplicationDraft[];
  followUps: FollowUpTask[];
  audit: AuditEvent[];
  recommendedResume: ResumeProfileSummary | null;
}
