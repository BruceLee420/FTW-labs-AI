/**
 * Deterministic scam signals. Each detector returns at most one Signal with a
 * stable code, a weight, a plain-language message and a ≤120-char quote from
 * the listing so the UI can always show WHY. Detectors are context-aware to
 * limit false positives (money verbs near "gift card", negation, employer
 * names containing "bank", etc.). Pure functions, no I/O.
 */
import type { Signal } from "../types/entities.ts";
import type { RuleInput } from "./types.ts";
import {
  emailHits,
  findAll,
  findFirst,
  hasHostedAtsUrl,
  isHostedAtsDomain,
  isNegated,
  isWebmailDomain,
  normalizeDomain,
  requirementLines,
  snippet,
  windowAround,
} from "./evidence.ts";
import { domainOf } from "../utils/url.ts";

export const SCAM_WEIGHTS = {
  REQUESTS_PAYMENT: 45,
  SENSITIVE_DATA_REQUEST: 40,
  MESSAGING_APP_ONLY: 30,
  GENERIC_WEBMAIL_CONTACT: 20,
  URL_DOMAIN_MISMATCH: 20,
  IDENTITY_INCONSISTENCY: 20,
  UNREALISTIC_COMPENSATION: 20,
  SUSPICIOUS_REDIRECT: 15,
  HIRING_PRESSURE: 15,
  VAGUE_DESCRIPTION: 15,
  UNCORROBORATED_ROLE: 10,
} as const;

type Code = keyof typeof SCAM_WEIGHTS;

function risk(code: Code, message: string, evidence: string | null): Signal {
  return { code, kind: "risk", weight: SCAM_WEIGHTS[code], message, evidence };
}

const PAYMENT_TERMS =
  /\b(gift\s*cards?|crypto(?:currency)?|bitcoin|btc|ethereum|usdt|wire\s+transfer|western\s+union|moneygram|zelle|cash\s*app|venmo|paypal|equipment\s+(?:check|cheque|fee|kit|deposit)|starter\s+kit|training\s+(?:fee|cost|kit)|processing\s+fee|application\s+fee|registration\s+fee|administration\s+fee|admin\s+fee|upfront\s+(?:fee|payment|cost|deposit)|background\s+check\s+fee|security\s+deposit|refundable\s+deposit|(?:cashier'?s?|certified)\s+(?:check|cheque)|mobile\s+(?:check|cheque)\s+deposit)\b/i;
const MONEY_VERBS = /\b(pay|pays|paid|paying|payment|send|sending|sent|purchase|purchasing|buy|buying|bought|deposit|depositing|transfer|transferring|wire|forward|forwarding|cover|reimburse|cash|cashing|invest|load|redeem|code|codes)\b/i;

function detectPayment(text: string): Signal | null {
  for (const hit of findAll(text, PAYMENT_TERMS)) {
    const around = windowAround(text, hit.index, hit.length, 90, 90);
    if (!MONEY_VERBS.test(around)) continue;
    if (isNegated(text, hit.index, 60)) continue; // "we will never ask you to pay…"
    return risk("REQUESTS_PAYMENT", "The listing asks the candidate to pay, buy or forward money or gift cards — legitimate employers never do this.", snippet(text, hit.index, hit.length));
  }
  return null;
}

const SENSITIVE_TERMS =
  /\b(ssn|social\s+security(?:\s+number)?|bank\s+(?:account|details|information|login)|routing\s+number|account\s+number|credit\s+card|debit\s+card|passwords?|verification\s+codes?|one[- ]time\s+(?:code|password|pin)|otp|driver'?s?\s+licen[cs]e\s*(?:scan|copy|photo|number)?|passport\s*(?:scan|copy|photo|number)|date\s+of\s+birth|mother'?s\s+maiden\s+name|tax\s+id|itin|national\s+id|id\s+card\s+(?:scan|copy|photo))\b/i;
const SENSITIVE_VERBS = /\b(send|provide|submit|share|upload|enter|attach|include|email|text|give|supply|verify|confirm|require|required|need|needed|must|collect)\b/i;
const OFFER_STAGE = /\b(after\s+(?:an?\s+)?(?:offer|hire|hiring|onboarding)|upon\s+(?:offer|hire|acceptance)|once\s+hired|background\s+check\s+will\s+be\s+conducted|i-?9|e-?verify|payroll\s+setup)\b/i;

function detectSensitive(text: string): Signal | null {
  for (const hit of findAll(text, SENSITIVE_TERMS)) {
    const around = windowAround(text, hit.index, hit.length, 100, 60);
    if (!SENSITIVE_VERBS.test(around)) continue;
    if (OFFER_STAGE.test(around)) continue; // normal post-offer paperwork
    if (isNegated(text, hit.index, 60)) continue;
    return risk("SENSITIVE_DATA_REQUEST", "Sensitive identification or financial details are requested before a legitimate hiring stage.", snippet(text, hit.index, hit.length));
  }
  return null;
}

const MESSAGING_APP = /\b(telegram|whatsapp|signal\s+(?:app|messenger|number)|wickr|google\s+(?:chat|hangouts)|skype\s+(?:only|chat|interview))\b|@[a-z0-9_]{4,}\s*(?:on\s+)?(?:telegram|whatsapp)/i;

function detectMessagingOnly(input: RuleInput): Signal | null {
  const hit = findFirst(input.description, [MESSAGING_APP]);
  if (!hit) return null;
  const hasOfficialTrail = Boolean(input.officialCareerUrl) || hasHostedAtsUrl(input) || input.sourceType === "OFFICIAL_ATS";
  if (hasOfficialTrail) return null;
  return risk("MESSAGING_APP_ONLY", "Recruiting runs through a messaging app (Telegram/WhatsApp/Signal) with no official company application trail.", snippet(input.description, hit.index, hit.length));
}

function detectWebmail(input: RuleInput): Signal | null {
  const expectCorporate = Boolean(input.companyDomain) || input.sourceType === "OFFICIAL_ATS" || Boolean(input.companyWebsite);
  for (const hit of emailHits(input.description)) {
    if (!isWebmailDomain(hit.domain)) continue;
    const evidence = snippet(input.description, hit.index, hit.length);
    if (expectCorporate) {
      return risk("GENERIC_WEBMAIL_CONTACT", "Contact goes to a personal webmail address although a corporate domain is expected.", evidence);
    }
    // No corporate domain known: still a warning sign for a named company, at half weight.
    return { ...risk("GENERIC_WEBMAIL_CONTACT", "Recruiting contact is a personal webmail address rather than a company domain.", evidence), weight: Math.round(SCAM_WEIGHTS.GENERIC_WEBMAIL_CONTACT / 2) };
  }
  return null;
}

function detectDomainMismatch(input: RuleInput): Signal | null {
  const appDomain = domainOf(input.applicationUrl);
  if (!appDomain || !input.companyDomain) return null;
  if (appDomain === input.companyDomain || isHostedAtsDomain(appDomain)) return null;
  return risk("URL_DOMAIN_MISMATCH", `The application URL is on ${appDomain}, not the company's domain (${input.companyDomain}) or a known applicant-tracking system.`, input.applicationUrl);
}

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "rebrand.ly", "cutt.ly", "is.gd", "buff.ly", "ow.ly", "shorturl.at", "rb.gy", "tiny.cc", "lnkd.in", "t.ly"]);
const REDIRECT_PARAMS = /[?&](?:redirect|redir|url|target|dest|destination|goto|next|return|tracking|track|click)=/i;

function detectRedirect(input: RuleInput): Signal | null {
  for (const url of [input.applicationUrl, input.sourceUrl]) {
    if (!url) continue;
    const d = domainOf(url);
    if (d && SHORTENERS.has(d)) return risk("SUSPICIOUS_REDIRECT", "The link goes through a URL shortener, which hides the real destination.", url);
    if (REDIRECT_PARAMS.test(url)) return risk("SUSPICIOUS_REDIRECT", "The link carries a redirect or tracking parameter that forwards elsewhere.", url);
  }
  return null;
}

function detectVague(input: RuleInput): Signal | null {
  const text = input.description.trim();
  const reqs = requirementLines(text);
  if (text.length < 300) return risk("VAGUE_DESCRIPTION", "The description is very short; there is not enough detail to judge the role.", text ? snippet(text, 0, Math.min(text.length, 80)) : null);
  if (reqs.length < 2) return risk("VAGUE_DESCRIPTION", "The description lists almost no concrete requirements or qualifications.", snippet(text, 0, 80));
  return null;
}

const NO_EXPERIENCE = /\b(no\s+experience(?:\s+(?:needed|necessary|required))?|entry[- ]level|no\s+skills?\s+(?:needed|required)|anyone\s+can|beginners?\s+welcome|no\s+interview)\b/i;
const PER_DAY_WEEK = /(?:earn|make|making|up\s+to|get\s+paid)\s*(?:up\s+to\s+)?\$\s?(\d{2,3}(?:,\d{3})?|\d+k)\s*(?:\+|per|a|\/|each|every)?\s*(day|daily|week|weekly)\b/i;

function detectUnrealisticComp(input: RuleInput): Signal | null {
  const text = input.description;
  const perDay = PER_DAY_WEEK.exec(text);
  if (perDay) {
    const amount = Number(String(perDay[1]).replace(/k$/i, "000").replace(/,/g, ""));
    const unit = perDay[2]!.toLowerCase();
    if ((unit.startsWith("day") && amount >= 300) || (unit.startsWith("week") && amount >= 1500)) {
      return risk("UNREALISTIC_COMPENSATION", "Promised earnings per day or week are far above what the role would normally pay.", snippet(text, perDay.index, perDay[0].length));
    }
  }
  const comp = input.compensation;
  const top = comp.max ?? comp.min;
  if (top === null) return null;
  const easy = NO_EXPERIENCE.test(text) || /\b(data\s+entry|typing|envelope|survey|package\s+(?:handler|reshipping)|mystery\s+shopper|personal\s+assistant)\b/i.test(`${input.title} ${text}`);
  if (comp.period === "HOUR" && top >= 150 && easy) return risk("UNREALISTIC_COMPENSATION", "An hourly rate this high for an entry-level or low-skill role is implausible.", comp.text);
  if (comp.period === "YEAR" && top >= 400000 && easy) return risk("UNREALISTIC_COMPENSATION", "A salary this high for a role that needs no experience is implausible.", comp.text);
  return null;
}

const PRESSURE = /\b(immediate\s+(?:hire|start|hiring|opening)|start\s+(?:today|tomorrow|immediately)|urgent(?:ly)?\s+(?:hiring|needed|required)?|hiring\s+(?:now|immediately|urgently)|limited\s+(?:slots?|spots?|positions?\s+available)|only\s+\d+\s+(?:slots?|spots?)\s+left|reply\s+within\s+\d+\s+hours?|respond\s+(?:immediately|asap|within\s+24)|no\s+interview\s+(?:needed|required|necessary)|apply\s+now\s+before|act\s+fast|first\s+come)\b/i;

function detectPressure(text: string): Signal | null {
  const hits = findAll(text, PRESSURE);
  if (!hits.length) return null;
  const strong = hits.some((h) => /no\s+interview|start\s+today|reply\s+within|slots?|spots?|act\s+fast/i.test(h.text));
  if (!strong && hits.length < 2) return null; // a single "hiring now" is common in real ads
  const first = hits[0]!;
  return risk("HIRING_PRESSURE", "The listing pushes for an immediate decision (start today, no interview, limited slots).", snippet(text, first.index, first.length));
}

function detectIdentityInconsistency(input: RuleInput): Signal | null {
  if (!input.companyDomain) return null;
  for (const hit of emailHits(input.description)) {
    if (isWebmailDomain(hit.domain)) continue; // handled by GENERIC_WEBMAIL_CONTACT
    if (hit.registrable === input.companyDomain || isHostedAtsDomain(hit.registrable)) continue;
    const sourceDomain = normalizeDomain(input.sourceUrl);
    if (sourceDomain && hit.registrable === sourceDomain) continue;
    return risk("IDENTITY_INCONSISTENCY", `The contact email domain (${hit.registrable}) does not match the company domain (${input.companyDomain}).`, snippet(input.description, hit.index, hit.length));
  }
  return null;
}

function detectUncorroborated(input: RuleInput): Signal | null {
  if (input.officialCareerUrl || hasHostedAtsUrl(input) || input.sourceType === "OFFICIAL_ATS" || input.companyWebsite) return null;
  return risk("UNCORROBORATED_ROLE", "Nothing ties this listing to an official company source yet (no career page, ATS listing or company website).", null);
}

export function detectScamSignals(input: RuleInput): Signal[] {
  const text = input.description ?? "";
  const signals = [
    detectPayment(text),
    detectSensitive(text),
    detectMessagingOnly(input),
    detectWebmail(input),
    detectDomainMismatch(input),
    detectRedirect(input),
    detectVague(input),
    detectUnrealisticComp(input),
    detectPressure(text),
    detectIdentityInconsistency(input),
    detectUncorroborated(input),
  ];
  return signals.filter((s): s is Signal => s !== null);
}
