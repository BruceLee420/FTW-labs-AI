/**
 * Repository contracts. Services depend on these interfaces only; the SQLite
 * implementations live in ./sqlite. Swap the implementation (Postgres, D1, an
 * HTTP-backed store) without touching services or routes.
 *
 * All methods are synchronous because node:sqlite is synchronous; wrap in
 * Promise-returning adapters if an async backend is introduced.
 */
import type {
  Application,
  ApplicationDraft,
  AuditEvent,
  DraftKind,
  Evaluation,
  FollowUpTask,
  Opportunity,
  OpportunitySource,
  ResumeProfile,
  SourceSyncRun,
} from "../types/entities.ts";
import type { OpportunityListQuery } from "../schemas/opportunity.ts";

export interface DuplicateProbe {
  canonicalUrl: string | null;
  sourceName: string;
  externalId: string | null;
  companyNameNormalized: string;
  titleNormalized: string;
  workMode: string;
  locationText: string | null;
  descriptionHash: string;
}

export interface OpportunityCounts {
  total: number;
  byStatus: Record<string, number>;
  byVerification: Record<string, number>;
  needsReview: number;
  verified: number;
  followUpsDue: number;
  readyToApply: number;
}

export interface OpportunityRepository {
  insert(opportunity: Opportunity): Opportunity;
  update(id: string, patch: Partial<Opportunity>): Opportunity | null;
  findById(id: string): Opportunity | null;
  list(query: OpportunityListQuery): { items: Opportunity[]; total: number };
  listAll(): Opportunity[];
  /** Candidate duplicates using the indexed keys; the dedupe service ranks them. */
  findDuplicateCandidates(probe: DuplicateProbe): Opportunity[];
  delete(id: string): boolean;
  deleteAll(): number;
  counts(now: string): OpportunityCounts;
  /** Opportunities whose application follow-up is due at or before `now`. */
  listFollowUpsDue(now: string): Opportunity[];
  listRecentVerified(limit: number): Opportunity[];
}

export interface OpportunitySourceRepository {
  insert(source: OpportunitySource): OpportunitySource;
  listByOpportunity(opportunityId: string): OpportunitySource[];
}

export interface EvaluationRepository {
  insert(evaluation: Evaluation): Evaluation;
  latestForOpportunity(opportunityId: string): Evaluation | null;
  listForOpportunity(opportunityId: string): Evaluation[];
}

export interface ResumeRepository {
  upsertByFilename(profile: ResumeProfile): ResumeProfile;
  update(id: string, patch: Partial<ResumeProfile>): ResumeProfile | null;
  findById(id: string): ResumeProfile | null;
  findByFilename(filename: string): ResumeProfile | null;
  /** Includes inactive profiles; callers filter. Text is included — do not send to browsers. */
  listAll(): ResumeProfile[];
  listActive(): ResumeProfile[];
  delete(id: string): boolean;
  deleteAll(): number;
}

export interface ApplicationRepository {
  insert(application: Application): Application;
  update(id: string, patch: Partial<Application>): Application | null;
  findById(id: string): Application | null;
  findByOpportunity(opportunityId: string): Application | null;
  listAll(): Application[];
  deleteAll(): number;
}

export interface DraftRepository {
  insert(draft: ApplicationDraft): ApplicationDraft;
  update(id: string, patch: Partial<ApplicationDraft>): ApplicationDraft | null;
  findById(id: string): ApplicationDraft | null;
  listByApplication(applicationId: string): ApplicationDraft[];
  latest(applicationId: string, kind: DraftKind): ApplicationDraft | null;
  findVersion(applicationId: string, kind: DraftKind, version: number): ApplicationDraft | null;
  listAll(): ApplicationDraft[];
  deleteAll(): number;
}

export interface FollowUpRepository {
  insert(task: FollowUpTask): FollowUpTask;
  update(id: string, patch: Partial<FollowUpTask>): FollowUpTask | null;
  findById(id: string): FollowUpTask | null;
  listByOpportunity(opportunityId: string): FollowUpTask[];
  listPending(): FollowUpTask[];
  listDue(now: string): FollowUpTask[];
  listAll(): FollowUpTask[];
  deleteAll(): number;
}

export interface SyncRunRepository {
  insert(run: SourceSyncRun): SourceSyncRun;
  update(id: string, patch: Partial<SourceSyncRun>): SourceSyncRun | null;
  listRecent(limit: number): SourceSyncRun[];
}

export interface AuditRepository {
  insert(event: AuditEvent): AuditEvent;
  listForEntity(entityType: AuditEvent["entityType"], entityId: string, limit?: number): AuditEvent[];
  listRecent(limit: number): AuditEvent[];
  deleteAll(): number;
}

export interface SettingsRepository {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  all(): Record<string, unknown>;
}

export interface Repositories {
  opportunities: OpportunityRepository;
  sources: OpportunitySourceRepository;
  evaluations: EvaluationRepository;
  resumes: ResumeRepository;
  applications: ApplicationRepository;
  drafts: DraftRepository;
  followUps: FollowUpRepository;
  syncRuns: SyncRunRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
  /** Run `fn` atomically. */
  transaction<T>(fn: () => T): T;
}
