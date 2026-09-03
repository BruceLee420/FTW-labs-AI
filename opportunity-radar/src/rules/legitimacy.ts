/**
 * Combines scam and positive signals into scores and a verification status.
 * The wording is graded on purpose: "likely legitimate", "needs manual
 * verification", "high risk" — never "safe". REJECTED_AS_SCAM is a user
 * decision and is never produced here.
 */
import type { RuleEvaluation, Signal, VerificationStatus } from "../types/entities.ts";
import type { RuleInput } from "./types.ts";
import { detectScamSignals } from "./scam.ts";
import { detectPositiveSignals } from "./positive.ts";

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function remoteEligibilityScore(input: Pick<RuleInput, "workMode" | "geographicEligibility">): number {
  const base = { REMOTE: 90, HYBRID: 45, ONSITE: 10, UNKNOWN: 40 }[input.workMode];
  const geo = { GLOBAL: 10, US_ONLY: 0, US_SPECIFIC_STATES: -10, COUNTRY_RESTRICTED: -20, UNKNOWN: -5 }[input.geographicEligibility];
  return clamp(base + geo);
}

export function verificationFor(legitimacy: number, scamRisk: number, signals: Signal[], input: RuleInput): VerificationStatus {
  const severe = signals.some((s) => s.kind === "risk" && s.weight >= 40);
  if (scamRisk >= 70 || severe) return "HIGH_RISK";
  if (scamRisk >= 40 || legitimacy < 45) return "NEEDS_MANUAL_REVIEW";
  const official = input.sourceType === "OFFICIAL_ATS" || signals.some((s) => s.code === "OFFICIAL_CAREER_PAGE");
  if (official && scamRisk < 25) return "VERIFIED_OFFICIAL_SOURCE";
  if (legitimacy >= 65 && scamRisk < 40) return "LIKELY_LEGIT";
  return "UNVERIFIED";
}

export function summaryLine(status: VerificationStatus): string {
  switch (status) {
    case "VERIFIED_OFFICIAL_SOURCE":
      return "Verified against an official source; still confirm the details on the employer's site before applying.";
    case "LIKELY_LEGIT":
      return "Likely legitimate based on the available signals; verify the employer before sharing personal data.";
    case "HIGH_RISK":
      return "High risk: one or more strong scam indicators were found. Do not pay, send documents or continue without independent verification.";
    case "NEEDS_MANUAL_REVIEW":
      return "Needs manual verification: some risk signals or missing corroboration. Check the company's official site and contact channels.";
    case "REJECTED_AS_SCAM":
      return "Rejected as a scam by the user.";
    default:
      return "Unverified: not enough corroborating information yet. Needs manual verification.";
  }
}

export function missingInformation(input: RuleInput): string[] {
  const missing: string[] = [];
  if (!input.companyWebsite) missing.push("company website");
  if (!input.officialCareerUrl) missing.push("official career page URL");
  if (!input.applicationUrl) missing.push("application URL");
  if (input.compensation.min === null && input.compensation.max === null && !input.compensation.text) missing.push("compensation");
  if (!input.postedAt) missing.push("posting date");
  if (!input.locationText && input.geographicEligibility === "UNKNOWN") missing.push("location or geographic eligibility");
  if (input.workMode === "UNKNOWN") missing.push("work mode (remote/hybrid/onsite)");
  if (!input.employmentType || input.employmentType === "UNKNOWN") missing.push("employment type");
  return missing;
}

export function evaluateRules(input: RuleInput): RuleEvaluation {
  const risks = detectScamSignals(input);
  const positives = detectPositiveSignals(input);
  const signals = [...risks, ...positives];
  let legitimacy = 50;
  let scamRisk = 10;
  for (const s of positives) legitimacy += s.weight;
  for (const s of risks) {
    scamRisk += s.weight;
    legitimacy -= s.weight / 2;
  }
  const legitimacyScore = clamp(legitimacy);
  const scamRiskScore = clamp(scamRisk);
  const verificationStatus = verificationFor(legitimacyScore, scamRiskScore, signals, input);
  const reasons = [summaryLine(verificationStatus), ...signals.map((s) => `${s.kind === "risk" ? "Risk" : "Positive"}: ${s.message}`)];
  return {
    legitimacyScore,
    scamRiskScore,
    remoteEligibilityScore: remoteEligibilityScore(input),
    relevanceScore: null,
    verificationStatus,
    signals,
    reasons,
    missingInformation: missingInformation(input),
  };
}
