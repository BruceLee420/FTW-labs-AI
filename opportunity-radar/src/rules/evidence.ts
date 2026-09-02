/**
 * Shared, pure text helpers for the rules layer: evidence snippets (≤ 120
 * chars quoted from the listing), sentence splitting, requirement-line
 * counting, e-mail/domain extraction and hosted-ATS checks.
 *
 * They live here so scam.ts, positive.ts and legitimacy.ts stay small and
 * never carry duplicate regexes. Nothing in this file performs I/O.
 */
import { collapseWhitespace, truncate } from "../utils/text.ts";
import { domainOf, HOSTED_ATS_DOMAINS, hostnameOf, registrableDomain } from "../utils/url.ts";

export const MAX_EVIDENCE = 120;

export interface TextMatch {
  index: number;
  length: number;
  text: string;
}

/** First match of any pattern (patterns are tried in order, earliest index wins per pattern). */
export function findFirst(text: string, patterns: readonly RegExp[]): TextMatch | null {
  for (const re of patterns) {
    const m = new RegExp(re.source, re.flags.replace("g", "")).exec(text);
    if (m && m[0].length > 0) return { index: m.index, length: m[0].length, text: m[0] };
  }
  return null;
}

/** All non-empty matches of a pattern (the global flag is added if missing). */
export function findAll(text: string, pattern: RegExp): TextMatch[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const out: TextMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ index: m.index, length: m[0].length, text: m[0] });
  }
  return out;
}

/** A ≤ 120-char quote around a match, whitespace-collapsed, centred on the match. */
export function snippet(text: string, index: number, length: number): string {
  const matched = text.slice(index, index + length);
  if (matched.length >= MAX_EVIDENCE) return truncate(collapseWhitespace(matched), MAX_EVIDENCE);
  const room = MAX_EVIDENCE - matched.length;
  const start = Math.max(0, index - Math.floor(room / 2));
  const end = Math.min(text.length, index + length + (room - (index - start)));
  return truncate(collapseWhitespace(text.slice(start, end)), MAX_EVIDENCE);
}

/** Raw text window around a match, used for context checks (verbs, negation). */
export function windowAround(text: string, index: number, length: number, before: number, after: number): string {
  return text.slice(Math.max(0, index - before), Math.min(text.length, index + length + after));
}

/** Text immediately before a match. */
export function textBefore(text: string, index: number, chars: number): string {
  return text.slice(Math.max(0, index - chars), index);
}

const NEGATION_RE = /\b(?:no|never|not|without|don'?t|do not|won'?t|will not|free|nor)\b/i;

/** True when the run-up to a match negates it ("we will never ask you to…"). */
export function isNegated(text: string, index: number, lookback = 45): boolean {
  return NEGATION_RE.test(textBefore(text, index, lookback));
}

/** Lines and sentences, bullets stripped, empties removed. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\r?\n+|(?<=[.!?;])\s+(?=[A-Z0-9•\-–*])/)
    .map((l) => l.replace(/^[\s•\-–—*·▪◦]+/, "").trim())
    .filter(Boolean);
}

export const REQUIREMENT_RE =
  /\b(?:\d+\+?\s*(?:years?|yrs)|years?\s+of|experience\s+(?:with|in|using|building|working|of)|proficien(?:t|cy)|knowledge\s+of|familiar(?:ity)?\s+with|strong\s+(?:understanding|background|skills?|communication|knowledge|experience)|understanding\s+of|expertise\s+(?:in|with)|background\s+in|ability\s+to|able\s+to|must\s+(?:be|have)|required|requirements?|qualifications?|degree\s+in|bachelor|master'?s|ph\.?d|fluent|fluency|certif(?:ied|ication)|track\s+record|hands[- ]on|comfortable\s+(?:with|working)|excellent\s+(?:written|verbal|communication)|skills?\s+(?:in|with)|nice\s+to\s+have|bonus\s+if|you\s+have)\b/i;

/** Sentences/lines that read like a job requirement (≥ 3 words and a requirement cue). */
export function requirementLines(text: string): string[] {
  return sentencesOf(text).filter((s) => s.split(/\s+/).length >= 3 && REQUIREMENT_RE.test(s));
}

export const EMAIL_RE = /\b[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi;

export interface EmailHit extends TextMatch {
  /** Lowercase full domain, e.g. "mail.example.co.uk". */
  domain: string;
  /** Lowercase registrable domain, e.g. "example.co.uk". */
  registrable: string;
}

export function emailHits(text: string): EmailHit[] {
  const out: EmailHit[] = [];
  const re = new RegExp(EMAIL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const domain = (m[1] ?? "").toLowerCase();
    out.push({ index: m.index, length: m[0].length, text: m[0], domain, registrable: registrableDomain(domain) });
  }
  return out;
}

const WEBMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "aol.com", "icloud.com", "me.com", "mac.com", "mail.com", "email.com",
  "yandex.com", "yandex.ru", "gmx.com", "gmx.de", "gmx.net", "zoho.com", "mail.ru", "qq.com", "163.com",
  "rediffmail.com", "fastmail.com", "tutanota.com", "tuta.io",
]);

export function isWebmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return WEBMAIL_DOMAINS.has(d) || WEBMAIL_DOMAINS.has(registrableDomain(d));
}

/** "https://www.Jobs.Example.com/x", "www.example.com" or "example.com" -> "example.com". */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const host = trimmed.includes("://") ? hostnameOf(trimmed) : trimmed.split(/[/?#]/)[0] ?? null;
  if (!host) return null;
  return registrableDomain(host.replace(/^www\./, ""));
}

export function isHostedAtsUrl(url: string | null | undefined): boolean {
  const d = domainOf(url);
  return d !== null && Object.hasOwn(HOSTED_ATS_DOMAINS, d);
}

export function isHostedAtsDomain(domain: string | null | undefined): boolean {
  return !!domain && Object.hasOwn(HOSTED_ATS_DOMAINS, registrableDomain(domain));
}

/** Any of the listing's URLs lives on a known hosted ATS (Greenhouse, Lever, …). */
export function hasHostedAtsUrl(urls: {
  sourceUrl: string | null;
  applicationUrl: string | null;
  canonicalUrl: string | null;
}): boolean {
  return isHostedAtsUrl(urls.sourceUrl) || isHostedAtsUrl(urls.applicationUrl) || isHostedAtsUrl(urls.canonicalUrl);
}
