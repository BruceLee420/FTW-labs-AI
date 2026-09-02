/**
 * Opportunity lifecycle: create (normalise → dedupe → persist → audit),
 * patch, status changes, notes, detail assembly and deletion. Evaluation is a
 * separate step (services/evaluate.ts) so creation works without a model.
 */
import type { AppDeps } from "../deps.ts";
import type { ManualOpportunityInput, OpportunityPatch } from "../schemas/opportunity.ts";
import type {
  Opportunity,
  OpportunityDetail,
  OpportunitySource,
  OpportunityStatus,
  ResumeProfile,
  ResumeProfileSummary,
} from "../types/entities.ts";
import { notFound } from "../utils/errors.ts";
import { newId } from "../utils/ids.ts";
import { canonicalizeUrl, domainOf } from "../utils/url.ts";
import { recordAudit } from "./audit.ts";
import { buildProbe, findDuplicate, type DedupeMatch } from "./dedupe.ts";
import { normalizeOpportunity } from "./normalize.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "logger">;

export interface CreateResult {
  opportunity: Opportunity;
  duplicate: boolean;
  duplicateOf: string | null;
  matchedOn: string[];
}

export function toResumeSummary(r: ResumeProfile): ResumeProfileSummary {
  const { extractedText, ...rest } = r;
  return { ...rest, extractedCharacters: extractedText.length };
}

/** Create an opportunity or, when it duplicates an existing one, record the sighting instead. */
export function createOpportunity(deps: Deps, input: ManualOpportunityInput, actor = "user"): CreateResult {
  const now = deps.now();
  const normalized = normalizeOpportunity({
    rawDescription: input.rawDescription,
    title: input.title,
    locationText: input.locationText ?? null,
    workMode: input.workMode,
    geographicEligibility: input.geographicEligibility,
    eligibleCountries: input.eligibleCountries,
    timezoneRequirements: input.timezoneRequirements ?? undefined,
    employmentType: input.employmentType,
    compensation: input.compensation
      ? {
          text: input.compensation.text ?? null,
          min: input.compensation.min ?? null,
          max: input.compensation.max ?? null,
          currency: input.compensation.currency ?? null,
          period: input.compensation.period,
        }
      : undefined,
    requiredSkills: input.requiredSkills,
    preferredSkills: input.preferredSkills,
  });
  const sourceUrl = input.sourceUrl ?? null;
  const applicationUrl = input.applicationUrl ?? sourceUrl;
  const canonicalUrl = input.canonicalUrl ? canonicalizeUrl(input.canonicalUrl) : sourceUrl ? canonicalizeUrl(sourceUrl) : null;
  const companyDomain = domainOf(input.companyWebsite) ?? domainOf(input.officialCareerUrl);

  const probe = buildProbe({
    canonicalUrl,
    sourceName: input.sourceName,
    externalId: input.externalId ?? null,
    companyName: input.companyName,
    title: input.title,
    workMode: normalized.workMode,
    locationText: input.locationText ?? null,
    descriptionHash: normalized.descriptionHash,
  });
  const dup = findDuplicate(deps.repos, probe);
  if (dup) return recordDuplicateSighting(deps, dup, input, canonicalUrl, normalized.descriptionHash, actor);

  const opportunity: Opportunity = {
    id: newId(),
    sourceName: input.sourceName,
    sourceType: input.sourceType,
    sourceUrl,
    canonicalUrl,
    applicationUrl,
    externalId: input.externalId ?? null,
    companyName: input.companyName,
    companyDomain,
    companyWebsite: input.companyWebsite ?? null,
    officialCareerUrl: input.officialCareerUrl ?? null,
    title: input.title,
    employmentType: normalized.employmentType,
    workMode: normalized.workMode,
    locationText: input.locationText ?? null,
    geographicEligibility: normalized.geographicEligibility,
    eligibleCountries: normalized.eligibleCountries,
    timezoneRequirements: normalized.timezoneRequirements,
    rawDescription: input.rawDescription,
    normalizedDescription: normalized.normalizedDescription,
    descriptionHash: normalized.descriptionHash,
    responsibilities: normalized.responsibilities,
    qualifications: normalized.qualifications,
    requiredSkills: normalized.requiredSkills,
    preferredSkills: normalized.preferredSkills,
    compensation: normalized.compensation,
    postedAt: input.postedAt ?? null,
    discoveredAt: now,
    closesAt: input.closesAt ?? null,
    relevanceScore: null,
    legitimacyScore: null,
    scamRiskScore: null,
    remoteEligibilityScore: null,
    verificationStatus: "UNVERIFIED",
    verificationReasons: [],
    scamSignals: [],
    status: "NORMALIZED",
    recommendedResumeId: null,
    matchRationale: null,
    nextAction: "Run the evaluation, then verify the source.",
    followUpDueAt: null,
    notes: input.notes ?? "",
    createdAt: now,
    updatedAt: now,
  };

  const created = deps.repos.transaction(() => {
    const row = deps.repos.opportunities.insert(opportunity);
    deps.repos.sources.insert(sourceRow(row.id, input, canonicalUrl, normalized.descriptionHash, now));
    recordAudit(deps.repos, deps.now, "opportunity", row.id, "opportunity.created", {
      sourceName: input.sourceName,
      sourceType: input.sourceType,
      sourceUrl,
    }, actor);
    recordAudit(deps.repos, deps.now, "opportunity", row.id, "opportunity.normalized", {
      workMode: normalized.workMode,
      workModeEvidence: normalized.workModeEvidence,
      geographicEligibility: normalized.geographicEligibility,
      geographyEvidence: normalized.geographyEvidence,
      requiredSkills: normalized.requiredSkills.length,
    }, "system");
    return row;
  });
  return { opportunity: created, duplicate: false, duplicateOf: null, matchedOn: [] };
}

function sourceRow(
  opportunityId: string,
  input: ManualOpportunityInput,
  canonicalUrl: string | null,
  descriptionHash: string,
  seenAt: string,
): OpportunitySource {
  return {
    id: newId(),
    opportunityId,
    sourceName: input.sourceName,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl ?? canonicalUrl,
    externalId: input.externalId ?? null,
    seenAt,
    descriptionHash,
  };
}

function recordDuplicateSighting(
  deps: Deps,
  dup: DedupeMatch,
  input: ManualOpportunityInput,
  canonicalUrl: string | null,
  descriptionHash: string,
  actor: string,
): CreateResult {
  const now = deps.now();
  const existing = dup.opportunity;
  const patch: Partial<Opportunity> = {};
  if (!existing.applicationUrl && input.applicationUrl) patch.applicationUrl = input.applicationUrl;
  if (!existing.companyWebsite && input.companyWebsite) patch.companyWebsite = input.companyWebsite;
  if (!existing.officialCareerUrl && input.officialCareerUrl) patch.officialCareerUrl = input.officialCareerUrl;
  if (!existing.postedAt && input.postedAt) patch.postedAt = input.postedAt;
  if (!existing.closesAt && input.closesAt) patch.closesAt = input.closesAt;
  if (!existing.canonicalUrl && canonicalUrl) patch.canonicalUrl = canonicalUrl;
  const updated = deps.repos.transaction(() => {
    deps.repos.sources.insert(sourceRow(existing.id, input, canonicalUrl, descriptionHash, now));
    recordAudit(deps.repos, deps.now, "opportunity", existing.id, "opportunity.duplicate_sighting", {
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl ?? null,
      matchedOn: dup.matchedOn,
      confidence: dup.confidence,
    }, actor);
    return Object.keys(patch).length ? deps.repos.opportunities.update(existing.id, patch)! : existing;
  });
  return { opportunity: updated, duplicate: true, duplicateOf: existing.id, matchedOn: dup.matchedOn };
}

export function patchOpportunity(deps: Deps, id: string, patch: OpportunityPatch, actor = "user"): Opportunity {
  const existing = deps.repos.opportunities.findById(id);
  if (!existing) throw notFound("No such opportunity.");
  const { renormalize, compensation, ...rest } = patch;
  const update: Partial<Opportunity> = { ...(rest as Partial<Opportunity>) };
  if (compensation) {
    update.compensation = {
      text: compensation.text ?? existing.compensation.text,
      min: compensation.min ?? existing.compensation.min,
      max: compensation.max ?? existing.compensation.max,
      currency: compensation.currency ?? existing.compensation.currency,
      period: compensation.period ?? existing.compensation.period,
    };
  }
  if (update.companyWebsite !== undefined || update.officialCareerUrl !== undefined) {
    update.companyDomain =
      patch.companyDomain ?? (domainOf(update.companyWebsite ?? existing.companyWebsite) ?? domainOf(update.officialCareerUrl ?? existing.officialCareerUrl));
  }
  if (update.sourceUrl !== undefined && update.canonicalUrl === undefined) {
    update.canonicalUrl = update.sourceUrl ? canonicalizeUrl(update.sourceUrl) : null;
  }
  if (renormalize || update.rawDescription !== undefined) {
    const n = normalizeOpportunity({
      rawDescription: update.rawDescription ?? existing.rawDescription,
      title: update.title ?? existing.title,
      locationText: update.locationText === undefined ? existing.locationText : update.locationText,
      workMode: update.workMode,
      geographicEligibility: update.geographicEligibility,
      eligibleCountries: update.eligibleCountries,
      timezoneRequirements: update.timezoneRequirements,
      employmentType: update.employmentType,
      compensation: update.compensation,
      requiredSkills: update.requiredSkills,
      preferredSkills: update.preferredSkills,
    });
    Object.assign(update, {
      normalizedDescription: n.normalizedDescription,
      descriptionHash: n.descriptionHash,
      responsibilities: update.responsibilities ?? n.responsibilities,
      qualifications: update.qualifications ?? n.qualifications,
      requiredSkills: n.requiredSkills,
      preferredSkills: n.preferredSkills,
      workMode: n.workMode,
      geographicEligibility: n.geographicEligibility,
      eligibleCountries: n.eligibleCountries,
      timezoneRequirements: n.timezoneRequirements,
      employmentType: n.employmentType,
      compensation: n.compensation,
    });
  }
  if (update.recommendedResumeId && !deps.repos.resumes.findById(update.recommendedResumeId)) {
    throw notFound("No such résumé profile.");
  }
  const updated = deps.repos.opportunities.update(id, update)!;
  const changed = Object.keys(update).filter((k) => JSON.stringify((existing as never)[k]) !== JSON.stringify((updated as never)[k]));
  if (changed.length) {
    recordAudit(deps.repos, deps.now, "opportunity", id, "opportunity.updated", { fields: changed }, actor);
    if (changed.includes("status")) {
      recordAudit(deps.repos, deps.now, "opportunity", id, "status.changed", { from: existing.status, to: updated.status }, actor);
    }
  }
  return updated;
}

export function changeStatus(deps: Deps, id: string, status: OpportunityStatus, note: string | undefined, actor = "user"): Opportunity {
  const existing = deps.repos.opportunities.findById(id);
  if (!existing) throw notFound("No such opportunity.");
  const updated = deps.repos.opportunities.update(id, {
    status,
    nextAction: nextActionFor(status),
    verificationStatus: status === "REJECTED" && existing.verificationStatus === "HIGH_RISK" ? "REJECTED_AS_SCAM" : existing.verificationStatus,
  })!;
  recordAudit(deps.repos, deps.now, "opportunity", id, "status.changed", { from: existing.status, to: status, note: note ?? null }, actor);
  return updated;
}

export function addNote(deps: Deps, id: string, note: string, actor = "user") {
  const existing = deps.repos.opportunities.findById(id);
  if (!existing) throw notFound("No such opportunity.");
  const stamped = `[${deps.now().slice(0, 10)}] ${note}`;
  const updated = deps.repos.opportunities.update(id, { notes: existing.notes ? `${existing.notes}\n${stamped}` : stamped })!;
  const audit = recordAudit(deps.repos, deps.now, "opportunity", id, "note.added", { note }, actor);
  return { opportunity: updated, audit };
}

export function deleteOpportunity(deps: Deps, id: string, actor = "user"): void {
  const existing = deps.repos.opportunities.findById(id);
  if (!existing) throw notFound("No such opportunity.");
  deps.repos.opportunities.delete(id);
  recordAudit(deps.repos, deps.now, "opportunity", id, "opportunity.deleted", { title: existing.title, companyName: existing.companyName }, actor);
}

export function getDetail(deps: Deps, id: string): OpportunityDetail {
  const opportunity = deps.repos.opportunities.findById(id);
  if (!opportunity) throw notFound("No such opportunity.");
  const application = deps.repos.applications.findByOpportunity(id);
  const recommended = opportunity.recommendedResumeId ? deps.repos.resumes.findById(opportunity.recommendedResumeId) : null;
  return {
    opportunity,
    sources: deps.repos.sources.listByOpportunity(id),
    latestEvaluation: deps.repos.evaluations.latestForOpportunity(id),
    application,
    drafts: application ? deps.repos.drafts.listByApplication(application.id) : [],
    followUps: deps.repos.followUps.listByOpportunity(id),
    audit: deps.repos.audit.listForEntity("opportunity", id, 200),
    recommendedResume: recommended ? toResumeSummary(recommended) : null,
  };
}

export function nextActionFor(status: OpportunityStatus): string | null {
  switch (status) {
    case "DISCOVERED":
    case "NORMALIZED":
      return "Run the evaluation, then verify the source.";
    case "REVIEW_NEEDED":
      return "Verify the employer through its official site before going further.";
    case "VERIFIED":
      return "Choose a résumé and generate a draft package.";
    case "READY_TO_APPLY":
      return "Submit on the official application page, then record it here.";
    case "DRAFT_PREPARED":
    case "AWAITING_APPROVAL":
      return "Review and edit the draft, then approve it.";
    case "APPLIED":
      return "Wait for the follow-up date.";
    case "FOLLOW_UP_DUE":
      return "Follow-up is due — draft and send it yourself.";
    case "FOLLOWED_UP":
      return "Wait for a reply; update the status when you hear back.";
    case "INTERVIEWING":
      return "Prepare for the interview; log outcomes here.";
    case "OFFER":
      return "Review the offer.";
    case "REJECTED":
    case "SKIPPED":
    case "CLOSED":
      return null;
    default:
      return null;
  }
}
