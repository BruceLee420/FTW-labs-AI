/** Positive legitimacy signals. Same shape as scam signals so the UI shows both sides. */
import type { Signal } from "../types/entities.ts";
import type { RuleInput } from "./types.ts";
import { emailHits, hasHostedAtsUrl, isHostedAtsDomain, isWebmailDomain, requirementLines } from "./evidence.ts";
import { domainOf, hostedAtsName } from "../utils/url.ts";

export const POSITIVE_WEIGHTS = {
  OFFICIAL_CAREER_PAGE: 25,
  OFFICIAL_ATS_SOURCE: 25,
  HOSTED_ATS_LISTING: 15,
  CONSISTENT_DOMAIN: 15,
  COMPLETE_DESCRIPTION: 10,
  TRANSPARENT_PROCESS: 5,
  VERIFIABLE_FOOTPRINT: 5,
} as const;

type Code = keyof typeof POSITIVE_WEIGHTS;

function positive(code: Code, message: string, evidence: string | null): Signal {
  return { code, kind: "positive", weight: POSITIVE_WEIGHTS[code], message, evidence };
}

const PROCESS_RE = /\b(interview\s+process|hiring\s+process|(?:first|second|final)\s+(?:round|stage|interview)|recruiter\s+screen|phone\s+screen|take[- ]home|onsite\s+interview|panel\s+interview|equal\s+opportunity\s+employer|eeo|affirmative\s+action|we\s+do\s+not\s+discriminate|accommodations?\s+(?:for|during)\s+(?:the\s+)?(?:interview|application))\b/i;
const ROLE_SECTION_RE = /\b(responsibilities|what\s+you(?:'|’)ll\s+do|what\s+you\s+will\s+do|about\s+the\s+role|the\s+role|your\s+role|key\s+responsibilities|duties)\b/i;

export function detectPositiveSignals(input: RuleInput): Signal[] {
  const out: Signal[] = [];
  const careerDomain = domainOf(input.officialCareerUrl);
  if (input.officialCareerUrl && input.companyDomain && careerDomain === input.companyDomain) {
    out.push(positive("OFFICIAL_CAREER_PAGE", "An official career page on the company's own domain is linked.", input.officialCareerUrl));
  }
  if (input.sourceType === "OFFICIAL_ATS") {
    out.push(positive("OFFICIAL_ATS_SOURCE", "The listing came from the employer's own applicant-tracking feed.", input.sourceName));
  }
  if (hasHostedAtsUrl(input)) {
    const url = [input.applicationUrl, input.sourceUrl, input.canonicalUrl].find((u) => u && hostedAtsName(u)) ?? null;
    out.push(positive("HOSTED_ATS_LISTING", `The listing lives on a recognised applicant-tracking system (${hostedAtsName(url) ?? "ATS"}).`, url));
  }
  const siteDomain = domainOf(input.companyWebsite);
  const appDomain = domainOf(input.applicationUrl);
  if (siteDomain && input.companyDomain && siteDomain === input.companyDomain && appDomain && (appDomain === input.companyDomain || isHostedAtsDomain(appDomain))) {
    out.push(positive("CONSISTENT_DOMAIN", "Company website, company domain and application URL all agree.", `${siteDomain} → ${appDomain}`));
  }
  const text = input.description;
  if (text.length >= 600 && requirementLines(text).length >= 3 && ROLE_SECTION_RE.test(text)) {
    out.push(positive("COMPLETE_DESCRIPTION", "The description is complete: a role section plus concrete requirements.", `${text.length} characters, ${requirementLines(text).length} requirement lines`));
  }
  const corporateContact = input.companyDomain ? emailHits(text).find((h) => h.registrable === input.companyDomain && !isWebmailDomain(h.domain)) : undefined;
  const process = PROCESS_RE.exec(text);
  if (process || corporateContact) {
    out.push(positive("TRANSPARENT_PROCESS", process ? "The hiring process or equal-opportunity policy is described." : "A contact on the corporate domain is provided.", process ? process[0] : corporateContact?.text ?? null));
  }
  if (input.companyWebsite) {
    out.push(positive("VERIFIABLE_FOOTPRINT", "A company website is on record, so the organisation can be checked independently.", input.companyWebsite));
  }
  return out;
}
