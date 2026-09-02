/**
 * Deterministic work-mode parser (REMOTE / HYBRID / ONSITE / UNKNOWN).
 *
 * Why: "remote" is the single most over-loaded word in job listings
 * ("remote sensing", "remote support", "remote work is not available"), so
 * the classification has to be explicit about negations and mixed signals.
 * Precedence: an explicit "not remote" wins (ONSITE) unless hybrid wording
 * is present; any hybrid cue (including "remote … must be onsite 2 days")
 * wins over plain remote; strong remote wording beats incidental office
 * mentions. Evidence quotes the decisive phrase.
 */
import type { WorkMode } from "../types/entities.ts";
import { findFirst, snippet } from "./evidence.ts";

const DAYS = "(?:\\d+|one|two|three|four|five|several|some|a few|certain|multiple)";
const DAY_RANGE = `${DAYS}\\s*(?:-|–|to)?\\s*${DAYS}?\\s*days?`;
const OFFICE = "(?:the\\s+)?(?:office|on[- ]?site|in[- ]person|in[- ]office|hq|headquarters)";

const NOT_REMOTE_RE =
  /\bno\s+remote\b|\bnot\s+(?:a\s+|an\s+)?remote\b|\bremote\s+work\s+is\s+not\b|\bnot\s+eligible\s+for\s+remote\b|\bremote\s+is\s+not\s+(?:available|an\s+option|possible|offered)\b|\bthis\s+(?:is\s+|position\s+is\s+|role\s+is\s+|job\s+is\s+)(?:an?\s+)?(?:fully\s+|100%\s+)?(?:on[- ]?site|in[- ]office|in[- ]person)\b|\b100%\s+(?:on[- ]?site|in[- ]office)\b|\bfully\s+(?:on[- ]?site|in[- ]office)\b|\bon[- ]?site\s+(?:only|required)\b|\bcannot\s+be\s+(?:performed\s+|done\s+)?remotely\b/i;

const HYBRID_RE = new RegExp(
  `\\bhybrid\\b|\\b${DAY_RANGE}\\s*(?:per|a|each|\\/)?\\s*(?:week|month)?\\s*(?:in|at|on)?\\s*${OFFICE}\\b|\\b${OFFICE}\\s+(?:for\\s+)?(?:at\\s+least\\s+)?${DAY_RANGE}\\b|\\bpartially\\s+remote\\b|\\bpartly\\s+remote\\b|\\bremote\\s+with\\s+(?:occasional|some|regular|periodic)\\b|\\bsome\\s+(?:on[- ]?site|in[- ]office|in[- ]person)\\s+(?:days|time|work|presence)\\b|\\boccasional\\s+(?:office|on[- ]?site|in[- ]person)\\s+(?:visits?|days|presence|attendance|travel\\s+to\\s+the\\s+office)\\b|\\bsplit\\s+(?:your\\s+)?time\\s+between\\s+(?:home|remote)\\b`,
  "i",
);

const REMOTE_STRONG_RE =
  /\b(?:fully|100\s?%|completely|entirely|permanently)[- ]remote\b|\bremote[- ](?:first|only|friendly)\b|\bwork\s+from\s+anywhere\b|\b(?:fully\s+)?distributed\s+(?:team|company|workforce|organi[sz]ation)\b|\btelecommut\w*\b|\bremote\s*[-–(:]+\s*(?:global|worldwide|anywhere|us|usa|u\.s\.|united states|canada|uk|eu|emea|latam|apac)\b/i;

const REMOTE_WEAK_RE =
  /\bremote\b(?![- ]?(?:sens\w*|monitor\w*|access|control|desktop|support|troubleshoot\w*|management|managed|site|sites|location|locations|area|areas|device|devices|patient|patients|hands|server|servers|system|systems|asset|assets|work\s+is\s+not|is\s+not|teams?\b|employees|workers|colleagues|collaboration|tools?))|\bwork(?:ing)?\s+from\s+home\b|\bwfh\b|\bhome[- ]based\b|\btelework\w*\b/i;

const ONSITE_RE =
  /\bon[- ]?site\b(?!\s*(?:interview|gym|parking|childcare|cafeteria|amenities|fitness|meals?|lunch|visits?|events?|training|support|customer|client))|\bin[- ]office\b|\bin\s+the\s+office\b|\boffice[- ]based\b|\bin[- ]person\b(?!\s*(?:interview|events?|meetups?|training|onboarding))|\bat\s+our\s+(?:office|headquarters|hq|facility|campus|location|plant|warehouse|store)\b|\bcommut\w*\s+distance\b|\brelocat\w*\s+(?:to|required)\b/i;

export interface WorkModeResult {
  workMode: WorkMode;
  evidence: string | null;
}

export function parseWorkMode(description: string, locationText: string | null): WorkModeResult {
  const location = locationText ?? "";
  const text = location ? `${location}\n${description}` : description;
  if (!text.trim()) return { workMode: "UNKNOWN", evidence: null };

  const notRemote = findFirst(text, [NOT_REMOTE_RE]);
  const hybrid = findFirst(text, [HYBRID_RE]);
  if (notRemote && !hybrid) return { workMode: "ONSITE", evidence: snippet(text, notRemote.index, notRemote.length) };
  if (hybrid) return { workMode: "HYBRID", evidence: snippet(text, hybrid.index, hybrid.length) };

  const remoteStrong = findFirst(text, [REMOTE_STRONG_RE]) ?? (/^\s*remote\b/i.test(location) ? findFirst(text, [/remote/i]) : null);
  const remote = remoteStrong ?? findFirst(text, [REMOTE_WEAK_RE]);
  const onsite = findFirst(text, [ONSITE_RE]);

  if (remote && onsite) {
    if (remoteStrong) return { workMode: "REMOTE", evidence: snippet(text, remoteStrong.index, remoteStrong.length) };
    return { workMode: "REMOTE", evidence: snippet(text, remote.index, remote.length) };
  }
  if (remote) return { workMode: "REMOTE", evidence: snippet(text, remote.index, remote.length) };
  if (onsite) return { workMode: "ONSITE", evidence: snippet(text, onsite.index, onsite.length) };
  return { workMode: "UNKNOWN", evidence: null };
}
