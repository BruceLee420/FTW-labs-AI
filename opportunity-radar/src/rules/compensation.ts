/**
 * Deterministic compensation parser.
 *
 * Why: salary text arrives in dozens of shapes ("$120k–150k", "€60.000",
 * "120-150K USD", "$40 - $55 per hour"). A model is not needed to read them,
 * and a pure parser gives stable numbers for filtering and for the
 * UNREALISTIC_COMPENSATION rule. Candidates are scored (period > range >
 * salary context > currency) so "$500 sign-on bonus" loses to the real range.
 * The `text` field is the matched snippet so the UI can quote it.
 */
import type { Compensation, CompensationPeriod } from "../types/entities.ts";
import { collapseWhitespace, truncate } from "../utils/text.ts";

const PREFIX_SRC =
  "(?:US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|S\\$|HK\\$|R\\$|MX\\$|\\$|€|£|₹|¥|₩|CHF|USD|EUR|GBP|CAD|AUD|NZD|INR|JPY|SGD|HKD|BRL|MXN|PLN|SEK|NOK|DKK|ZAR|AED|KRW|CNY|RMB|Rs\\.?)";
const CODE_SRC =
  "(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|INR|JPY|SGD|HKD|BRL|MXN|PLN|SEK|NOK|DKK|ZAR|AED|KRW|CNY|RMB)";
const NOT_MONEY_SRC =
  "(?!\\s*(?:m|mm|million|bn|billion|%|percent|employees|people|users|customers|years?|yrs|hours?|hrs|days?|weeks?|months?)\\b)";
const AMOUNT_SRC = `(\\d{1,3}(?:[,.]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)\\s*(k|thousand)?${NOT_MONEY_SRC}`;
const PERIOD_SRC =
  "(?:(?:per|each|\\/)\\s*(?:year|yr|annum|month|mo|week|wk|day|hour|hr|h)\\b|annually|yearly|per annum|p\\.a\\.|monthly|weekly|daily|hourly|an hour|a year|a month|a week|a day)";
const RANGE_SEP = "\\s*(?:-|–|—|to|and)\\s*";

const MAIN_RE = new RegExp(
  `(?<![A-Za-z0-9.])(?:(${PREFIX_SRC})\\s?)?${AMOUNT_SRC}(?:${RANGE_SEP}(?:(${PREFIX_SRC})\\s?)?${AMOUNT_SRC})?(?:\\s*(${CODE_SRC})\\b)?(?:\\s*(${PERIOD_SRC}))?`,
  "gi",
);

const CONTEXT_RE = /\b(?:salary|salaries|compensation|comp|pay|paid|pays|base|rate|range|earn\w*|annual|ote|wage|wages|remuneration|package|stipend|budget)\b/i;
const UP_TO_RE = /\b(?:up\s+to|max(?:imum)?(?:\s+of)?|not\s+more\s+than)\s*[:\-]?\s*$/i;
const FROM_RE = /\b(?:from|starting\s+(?:at|from)|min(?:imum)?(?:\s+of)?|at\s+least|over|above)\s*[:\-]?\s*$/i;

const SYMBOLS: Record<string, string> = {
  "$": "USD", "US$": "USD", "CA$": "CAD", "C$": "CAD", "AU$": "AUD", "A$": "AUD", "NZ$": "NZD",
  "S$": "SGD", "HK$": "HKD", "R$": "BRL", "MX$": "MXN", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY",
  "₩": "KRW", RS: "INR", "RS.": "INR", RMB: "CNY",
};

function currencyOf(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.trim();
  return SYMBOLS[t] ?? SYMBOLS[t.toUpperCase()] ?? t.toUpperCase();
}

/** "120,000" / "60.000" / "1,500.50" / "45.5" -> number. Thousands vs decimal decided by group length. */
export function parseAmount(raw: string, thousandsSuffix: string | undefined): number | null {
  let s = raw.replace(/\s+/g, "");
  let value: number;
  if (/^\d{1,3}(?:[,.]\d{3})+(?:[.,]\d{1,2})?$/.test(s)) {
    const decimal = s.match(/[.,](\d{1,2})$/);
    if (decimal) s = s.slice(0, -(decimal[0].length));
    value = Number(s.replace(/[,.]/g, "")) + (decimal ? Number(`0.${decimal[1]}`) : 0);
  } else {
    value = Number(s.replace(",", "."));
  }
  if (!Number.isFinite(value)) return null;
  if (thousandsSuffix) value *= 1000;
  return value;
}

function periodOf(token: string | undefined): CompensationPeriod {
  if (!token) return "UNKNOWN";
  const t = token.toLowerCase();
  if (/year|yr|annu|p\.a\./.test(t)) return "YEAR";
  if (/month|mo\b/.test(t)) return "MONTH";
  if (/week|wk/.test(t)) return "WEEK";
  if (/day|daily/.test(t)) return "DAY";
  if (/hour|hr|\bh\b|\/h/.test(t)) return "HOUR";
  return "UNKNOWN";
}

interface Candidate extends Compensation {
  score: number;
}

const EMPTY: Compensation = { text: null, min: null, max: null, currency: null, period: "UNKNOWN" };

export function parseCompensation(text: string): Compensation {
  if (!text) return { ...EMPTY };
  const cleaned = text.replace(/401\s*\(?k\)?/gi, " ");
  const re = new RegExp(MAIN_RE.source, MAIN_RE.flags);
  let best: Candidate | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const cand = toCandidate(cleaned, m);
    if (cand && (!best || cand.score > best.score)) best = cand;
  }
  if (!best) return { ...EMPTY };
  const { score: _score, ...comp } = best;
  return comp;
}

function toCandidate(text: string, m: RegExpExecArray): Candidate | null {
  const [whole, prefix1, amount1, k1, prefix2, amount2, k2, code, periodToken] = m;
  if (!amount1) return null;
  const secondHasK = !!k2;
  let min = parseAmount(amount1, k1 ?? (secondHasK && !k1 && Number(amount1.replace(/[,.]/g, "")) < 1000 ? k2 : undefined));
  let max = amount2 ? parseAmount(amount2, k2) : null;
  if (min === null) return null;
  // Implausible ranges ("$500 bonus and 2,000 shares") keep only the first amount.
  if (max !== null && (max < min || max > min * 12)) max = null;
  if (max === null) max = min;

  const currency = currencyOf(code) ?? currencyOf(prefix1) ?? currencyOf(prefix2);
  const explicitPeriod = periodOf(periodToken);
  const hasK = !!k1 || !!k2;
  const before = text.slice(Math.max(0, m.index - 80), m.index);
  const after = text.slice(m.index + whole.length, m.index + whole.length + 80);
  const hasContext = CONTEXT_RE.test(before) || CONTEXT_RE.test(after);
  const value = Math.max(min, max);

  if (!currency && !hasContext) return null;
  if (!currency && explicitPeriod === "UNKNOWN" && !hasK && value < 1000) return null;
  if (currency && explicitPeriod === "UNKNOWN" && !hasK && value < 1000) return null;
  if (explicitPeriod === "HOUR" && value > 2000) return null;
  if (value < 5) return null;

  const isRange = !!amount2 && max !== min;
  const lead = text.slice(Math.max(0, m.index - 24), m.index);
  let lo: number | null = min;
  let hi: number | null = max;
  if (!isRange && UP_TO_RE.test(lead)) lo = null;
  else if (!isRange && FROM_RE.test(lead)) hi = null;

  const period: CompensationPeriod =
    explicitPeriod !== "UNKNOWN" ? explicitPeriod : value >= 10000 ? "YEAR" : "UNKNOWN";
  const score = (explicitPeriod !== "UNKNOWN" ? 4 : 0) + (isRange ? 2 : 0) + (hasContext ? 3 : 0) + (currency ? 1 : 0);
  return { text: truncate(collapseWhitespace(whole), 120), min: lo, max: hi, currency, period, score };
}
