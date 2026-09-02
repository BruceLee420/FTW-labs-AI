export type { RuleInput } from "./types.ts";
export { detectScamSignals, SCAM_WEIGHTS } from "./scam.ts";
export { detectPositiveSignals, POSITIVE_WEIGHTS } from "./positive.ts";
export { parseGeographicEligibility, parseTimezoneRequirement, type GeographyResult } from "./geography.ts";
export { parseWorkMode, type WorkModeResult } from "./workMode.ts";
export { parseEmploymentType } from "./employmentType.ts";
export { parseCompensation } from "./compensation.ts";
export { evaluateRules, remoteEligibilityScore, verificationFor, summaryLine, missingInformation } from "./legitimacy.ts";
