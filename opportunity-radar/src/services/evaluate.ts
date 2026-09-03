/**
 * Evaluation = deterministic rules (always) + résumé matching (always) +
 * advisory model analysis (when available and not rules-only). The rules'
 * scam-risk is a floor the model cannot lower. Everything is stored with
 * prompt version, model name and timestamp for audit.
 */
import type { AppDeps } from "../deps.ts";
import type { AiEvaluation, Evaluation, Opportunity, ResumeProfile, RuleEvaluation, VerificationStatus } from "../types/entities.ts";
import { evaluateRules } from "../rules/index.ts";
import type { RuleInput } from "../rules/types.ts";
import { generateStructured } from "../ai/structured.ts";
import { AiInvalidOutputError, AiUnavailableError } from "../ai/provider.ts";
import { AiEvaluationSchema } from "../schemas/ai.ts";
import { buildEvaluatePrompt, EVALUATE_PROMPT_VERSION } from "../prompts/evaluate.ts";
import { newId } from "../utils/ids.ts";
import { truncate } from "../utils/text.ts";
import { recordAudit } from "./audit.ts";
import { defaultRetriever, type ResumeCandidate, type ResumeRetriever } from "./resumeMatch.ts";
import { requireOpportunity } from "./applications.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "ai" | "logger">;

export interface EvaluateOptions {
  rulesOnly?: boolean;
  retriever?: ResumeRetriever;
  actor?: string;
}

export function ruleInputFrom(o: Opportunity): RuleInput {
  return {
    title: o.title,
    companyName: o.companyName,
    companyDomain: o.companyDomain,
    companyWebsite: o.companyWebsite,
    officialCareerUrl: o.officialCareerUrl,
    sourceUrl: o.sourceUrl,
    applicationUrl: o.applicationUrl,
    canonicalUrl: o.canonicalUrl,
    sourceType: o.sourceType,
    sourceName: o.sourceName,
    description: o.normalizedDescription || o.rawDescription,
    locationText: o.locationText,
    workMode: o.workMode,
    geographicEligibility: o.geographicEligibility,
    compensation: o.compensation,
    postedAt: o.postedAt,
    employmentType: o.employmentType,
  };
}

/** Combine rule scores with optional model scores. Rules floor the scam risk. */
export function combineScores(rules: RuleEvaluation, ai: AiEvaluation | null, relevanceFromMatch: number | null) {
  const legitimacy = ai ? Math.round(rules.legitimacyScore * 0.6 + ai.legitimacyScore * 0.4) : rules.legitimacyScore;
  const scamRisk = ai ? Math.max(rules.scamRiskScore, Math.round(rules.scamRiskScore * 0.5 + ai.scamRiskScore * 0.5)) : rules.scamRiskScore;
  const remote = ai ? Math.round(rules.remoteEligibilityScore * 0.6 + ai.remoteEligibilityScore * 0.4) : rules.remoteEligibilityScore;
  let relevance: number | null = relevanceFromMatch;
  if (ai && relevance !== null) relevance = Math.round(relevance * 0.5 + ai.relevanceScore * 0.5);
  else if (ai) relevance = ai.relevanceScore;
  return { legitimacyScore: clamp(legitimacy), scamRiskScore: clamp(scamRisk), remoteEligibilityScore: clamp(remote), relevanceScore: relevance === null ? null : clamp(relevance) };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Verification status after combining: the rules decide, the model can only escalate. */
export function combinedVerification(rules: RuleEvaluation, scamRisk: number): VerificationStatus {
  if (rules.verificationStatus === "HIGH_RISK" || scamRisk >= 70) return "HIGH_RISK";
  if (rules.verificationStatus === "NEEDS_MANUAL_REVIEW" || scamRisk >= 40) return "NEEDS_MANUAL_REVIEW";
  return rules.verificationStatus;
}

function statusAfterEvaluation(current: Opportunity["status"], verification: VerificationStatus): Opportunity["status"] {
  const early = new Set(["DISCOVERED", "NORMALIZED", "REVIEW_NEEDED", "VERIFIED"]);
  if (!early.has(current)) return current;
  if (verification === "VERIFIED_OFFICIAL_SOURCE" || verification === "LIKELY_LEGIT") return "VERIFIED";
  return "REVIEW_NEEDED";
}

export async function evaluateOpportunity(deps: Deps, id: string, options: EvaluateOptions = {}): Promise<{ opportunity: Opportunity; evaluation: Evaluation }> {
  const opportunity = requireOpportunity(deps, id);
  const rules = evaluateRules(ruleInputFrom(opportunity));
  const retriever = options.retriever ?? defaultRetriever;
  const candidates = retriever.retrieve(opportunity, deps.repos.resumes.listActive(), 3);
  const best = candidates[0] ?? null;
  const relevanceFromMatch = best ? best.score : null;

  let ai: AiEvaluation | null = null;
  let aiStatus: Evaluation["aiStatus"] = "DISABLED";
  let aiError: string | null = null;
  let model: string | null = null;
  let promptVersion: string | null = null;

  if (!options.rulesOnly && deps.ai.id !== "none") {
    promptVersion = EVALUATE_PROMPT_VERSION;
    model = deps.ai.model;
    try {
      const prompt = buildEvaluatePrompt({
        opportunity: {
          title: opportunity.title,
          companyName: opportunity.companyName,
          companyDomain: opportunity.companyDomain,
          sourceType: opportunity.sourceType,
          sourceName: opportunity.sourceName,
          sourceUrl: opportunity.sourceUrl,
          applicationUrl: opportunity.applicationUrl,
          officialCareerUrl: opportunity.officialCareerUrl,
          workMode: opportunity.workMode,
          locationText: opportunity.locationText,
          geographicEligibility: opportunity.geographicEligibility,
          employmentType: opportunity.employmentType,
          compensationText: opportunity.compensation.text,
          description: truncate(opportunity.normalizedDescription || opportunity.rawDescription, 8000),
        },
        rules: {
          legitimacyScore: rules.legitimacyScore,
          scamRiskScore: rules.scamRiskScore,
          remoteEligibilityScore: rules.remoteEligibilityScore,
          verificationStatus: rules.verificationStatus,
          signals: rules.signals.map((s) => ({ code: s.code, kind: s.kind, message: s.message, evidence: s.evidence })),
          missingInformation: rules.missingInformation,
        },
        candidateResumes: candidates.map((c) => candidateSummary(c)),
      });
      const result = await generateStructured(deps.ai, AiEvaluationSchema, prompt);
      model = result.model;
      ai = sanitizeAi(result.data, candidates.map((c) => c.resume.id));
      aiStatus = "OK";
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        aiStatus = "UNAVAILABLE";
        aiError = err.message;
      } else if (err instanceof AiInvalidOutputError) {
        aiStatus = "INVALID_OUTPUT";
        aiError = err.message;
      } else {
        aiStatus = "ERROR";
        aiError = (err as Error)?.name ?? "error";
        deps.logger.error("evaluation failed", { opportunityId: id, error: (err as Error)?.message });
      }
    }
  }

  const scores = combineScores(rules, ai, relevanceFromMatch);
  const verification = combinedVerification(rules, scores.scamRiskScore);
  const recommended = pickRecommended(candidates, ai);
  const matchRationale = recommended ? recommended.rationale : candidates.length === 0 ? "No active résumé profiles indexed yet." : null;

  const evaluation: Evaluation = {
    id: newId(),
    opportunityId: id,
    createdAt: deps.now(),
    promptVersion,
    provider: deps.ai.id,
    model,
    aiStatus,
    aiError,
    rules,
    ai,
    candidateResumeIds: candidates.map((c) => c.resume.id),
    recommendedResumeId: recommended?.resume.id ?? null,
    matchRationale,
  };

  const reasons = [...rules.reasons];
  if (ai) reasons.push(`Model (advisory, ${ai.confidence} confidence): ${truncate(ai.rationale, 300)}`);
  const nextAction = ai?.suggestedNextAction ?? (verification === "HIGH_RISK" ? "Do not apply; treat as a likely scam." : verification === "NEEDS_MANUAL_REVIEW" ? "Verify the employer through its official site." : "Choose a résumé and generate a draft package.");

  const updated = deps.repos.transaction(() => {
    deps.repos.evaluations.insert(evaluation);
    const row = deps.repos.opportunities.update(id, {
      ...scores,
      verificationStatus: verification,
      verificationReasons: reasons,
      scamSignals: rules.signals,
      recommendedResumeId: recommended?.resume.id ?? opportunity.recommendedResumeId,
      matchRationale,
      nextAction,
      status: statusAfterEvaluation(opportunity.status, verification),
    })!;
    recordAudit(deps.repos, deps.now, "opportunity", id, "opportunity.evaluated", {
      evaluationId: evaluation.id,
      provider: deps.ai.id,
      model,
      promptVersion,
      aiStatus,
      ...scores,
      verificationStatus: verification,
      recommendedResumeId: recommended?.resume.id ?? null,
    }, options.actor ?? "system");
    if (row.status !== opportunity.status) {
      recordAudit(deps.repos, deps.now, "opportunity", id, "status.changed", { from: opportunity.status, to: row.status }, "system");
    }
    return row;
  });
  return { opportunity: updated, evaluation };
}

function candidateSummary(c: ResumeCandidate) {
  const r: ResumeProfile = c.resume;
  return {
    id: r.id,
    label: r.label,
    targetRoles: r.targetRoles,
    skills: r.skills.slice(0, 40),
    industries: r.industries,
    experienceSummary: truncate(r.experienceSummary, 600),
  };
}

/** Keep model output within the candidate set; drop unknown résumé ids. */
function sanitizeAi(ai: AiEvaluation, candidateIds: string[]): AiEvaluation {
  return { ...ai, bestResumeId: ai.bestResumeId && candidateIds.includes(ai.bestResumeId) ? ai.bestResumeId : null };
}

function pickRecommended(candidates: ResumeCandidate[], ai: AiEvaluation | null): ResumeCandidate | null {
  if (!candidates.length) return null;
  if (ai?.bestResumeId) {
    const chosen = candidates.find((c) => c.resume.id === ai.bestResumeId);
    if (chosen) return chosen;
  }
  return candidates[0] ?? null;
}
