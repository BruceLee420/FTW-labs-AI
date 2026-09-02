/**
 * Deterministic geographic-eligibility parser.
 *
 * Why: whether a remote role is open to the candidate is the first filter a
 * job seeker applies, and listings state it in a small number of recurring
 * phrasings. This module recognises them without a model and returns
 * ISO-3166 alpha-2 codes (US states as "US-CA") plus a quoted evidence
 * snippet and any timezone requirement. Country mentions only count when
 * they sit in eligibility context ("based in", "candidates in", …) so
 * "offices in London and Berlin" does not restrict a global role.
 * Precedence: state lists > location "Remote - <State>" > named countries /
 * regions > US-only phrases > global phrases > UNKNOWN.
 */
import type { GeographicEligibility } from "../types/entities.ts";
import { collapseWhitespace, truncate, uniqueStrings } from "../utils/text.ts";
import { findAll, findFirst, snippet, textBefore, windowAround } from "./evidence.ts";
import type { TextMatch } from "./evidence.ts";

export interface GeographyResult {
  eligibility: GeographicEligibility;
  eligibleCountries: string[];
  timezoneRequirements: string | null;
  evidence: string | null;
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "washington, d.c.": "DC", "washington d.c.": "DC", "washington dc": "DC",
};
const STATE_ABBRS = new Set(Object.values(US_STATES));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STATE_NAME_RE = new RegExp(
  "\\b(" + Object.keys(US_STATES).sort((a, b) => b.length - a.length).map(escapeRe).join("|") + ")(?![a-z])",
  "gi",
);
const STATE_ABBR_RE = /(?:\bin\s+|,\s*|:\s*|\bor\s+|\band\s+|\/\s*|\(|^)\s*([A-Z]{2})(?![A-Za-z])/g;
const STATE_NAMES_SRC = "(?:" + Object.keys(US_STATES).filter((k) => !k.includes(",")).map(escapeRe).join("|") + ")";

/** "US-CA" codes found in a clause; full names (any case) and upper-case abbreviations in list position. */
function statesIn(clause: string): string[] {
  const codes: string[] = [];
  for (const m of findAll(clause, STATE_NAME_RE)) codes.push("US-" + US_STATES[m.text.toLowerCase()]!);
  for (const m of findAll(clause, STATE_ABBR_RE)) {
    const abbr = m.text.match(/([A-Z]{2})(?![A-Za-z])\s*$/)?.[1];
    if (abbr && STATE_ABBRS.has(abbr)) codes.push("US-" + abbr);
  }
  return uniqueStrings(codes);
}

const STATE_CLAUSE_RE =
  /\b(?:only|residing|reside|residents?|located|living|live|based|available|hire|hiring|candidates|applicants|eligible|except|excluding|excluded|exclude|not\s+(?:available|open|hiring|able|eligible|currently)|cannot|can't|unable|outside|following\s+states|these\s+states|states?\s+of|limited\s+to|restricted\s+to|open\s+to)\b[^.\n;]{0,140}/gi;

const COUNTRIES: [string, string][] = [
  ["united kingdom", "GB"], ["great britain", "GB"], ["britain", "GB"], ["england", "GB"], ["scotland", "GB"],
  ["wales", "GB"], ["northern ireland", "GB"], ["u\\.k\\.", "GB"], ["uk", "GB"], ["ireland", "IE"], ["germany", "DE"],
  ["france", "FR"], ["spain", "ES"], ["italy", "IT"], ["portugal", "PT"], ["netherlands", "NL"], ["holland", "NL"],
  ["belgium", "BE"], ["luxembourg", "LU"], ["switzerland", "CH"], ["austria", "AT"], ["sweden", "SE"], ["norway", "NO"],
  ["denmark", "DK"], ["finland", "FI"], ["iceland", "IS"], ["poland", "PL"], ["czech republic", "CZ"], ["czechia", "CZ"],
  ["slovakia", "SK"], ["hungary", "HU"], ["romania", "RO"], ["bulgaria", "BG"], ["greece", "GR"], ["croatia", "HR"],
  ["slovenia", "SI"], ["estonia", "EE"], ["latvia", "LV"], ["lithuania", "LT"], ["ukraine", "UA"], ["serbia", "RS"],
  ["turkey", "TR"], ["türkiye", "TR"], ["israel", "IL"], ["united arab emirates", "AE"], ["uae", "AE"], ["dubai", "AE"],
  ["saudi arabia", "SA"], ["qatar", "QA"], ["egypt", "EG"], ["south africa", "ZA"], ["nigeria", "NG"], ["kenya", "KE"],
  ["morocco", "MA"], ["ghana", "GH"], ["canada", "CA"], ["mexico", "MX"], ["brazil", "BR"], ["argentina", "AR"],
  ["chile", "CL"], ["colombia", "CO"], ["peru", "PE"], ["uruguay", "UY"], ["ecuador", "EC"], ["costa rica", "CR"],
  ["guatemala", "GT"], ["dominican republic", "DO"], ["panama", "PA"], ["venezuela", "VE"], ["bolivia", "BO"],
  ["paraguay", "PY"], ["india", "IN"], ["pakistan", "PK"], ["bangladesh", "BD"], ["sri lanka", "LK"],
  ["singapore", "SG"], ["malaysia", "MY"], ["indonesia", "ID"], ["philippines", "PH"], ["thailand", "TH"],
  ["vietnam", "VN"], ["japan", "JP"], ["south korea", "KR"], ["korea", "KR"], ["china", "CN"], ["hong kong", "HK"],
  ["taiwan", "TW"], ["australia", "AU"], ["new zealand", "NZ"], ["cyprus", "CY"], ["malta", "MT"],
];
const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const EUROPE = [...EU, "GB", "CH", "NO", "IS", "UA", "RS"];
const MIDDLE_EAST = ["AE", "SA", "QA", "IL", "TR", "EG"];
const EMEA = [...EUROPE, ...MIDDLE_EAST, "ZA", "NG", "KE", "MA", "GH"];
const LATAM = ["MX", "BR", "AR", "CL", "CO", "PE", "UY", "EC", "CR", "GT", "DO", "PA", "VE", "BO", "PY"];
const APAC = ["AU", "NZ", "JP", "KR", "CN", "IN", "SG", "MY", "ID", "PH", "TH", "VN", "HK", "TW", "PK", "BD", "LK"];
const NORTH_AMERICA = ["US", "CA", "MX"];
const REGIONS: [string, string[]][] = [
  ["emea", EMEA], ["latam", LATAM], ["latin america", LATAM], ["south america", LATAM], ["apac", APAC],
  ["asia[- ]pacific", APAC], ["european union", EU], ["eu", EU], ["europe", EUROPE], ["european", EUROPE],
  ["nordics?", ["DK", "FI", "IS", "NO", "SE"]], ["scandinavia", ["DK", "NO", "SE"]], ["dach", ["DE", "AT", "CH"]],
  ["benelux", ["BE", "NL", "LU"]], ["anz", ["AU", "NZ"]], ["north america", NORTH_AMERICA],
  ["the americas", [...NORTH_AMERICA, ...LATAM]], ["americas", [...NORTH_AMERICA, ...LATAM]],
  ["central and eastern europe", ["PL", "CZ", "SK", "HU", "RO", "BG", "HR", "SI", "EE", "LV", "LT"]],
  ["cee", ["PL", "CZ", "SK", "HU", "RO", "BG", "HR", "SI", "EE", "LV", "LT"]], ["middle east", MIDDLE_EAST],
];
const PLACE_RES: { re: RegExp; codes: string[] }[] = [
  ...REGIONS.map(([src, codes]) => ({ re: new RegExp(`\\b${src}(?![a-z])`, "gi"), codes })),
  ...COUNTRIES.map(([src, code]) => ({ re: new RegExp(`\\b${src}(?![a-z])`, "gi"), codes: [code] })),
];

const ELIG_CONTEXT_RE =
  /\b(?:remote|based|located|location|reside\w*|resident\w*|eligib\w*|candidates?|applicants?|must|only|hire|hiring|work(?:ing)?\s+from|authori[sz]\w*|right\s+to\s+work|permit|visa|citizen\w*|time\s*zones?|timezones?|within|restricted|open\s+to|available\s+(?:in|to|for)|countries|live|living|residing)\b/i;
const HQ_BEFORE_RE =
  /\b(?:headquartered|headquarters|hq|offices?|founded|company|startup|teams?|customers?|clients?|users?|presence|operations|markets?|expanding|expansion|serving)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:located\s+|based\s+|headquartered\s+)?(?:in|across|throughout|into|to)\s+(?:the\s+)?$/i;
const EXCLUDED_BEFORE_RE = /\b(?:except|excluding|excluded|exclude|not|cannot|can't|unable|outside|other\s+than)\b[^.;\n]*$/i;

interface PlaceHit extends TextMatch {
  codes: string[];
  excluded: boolean;
}

function placeHits(text: string, requireContext: boolean): PlaceHit[] {
  const hits: PlaceHit[] = [];
  for (const { re, codes } of PLACE_RES) {
    for (const m of findAll(text, re)) {
      if (requireContext) {
        if (HQ_BEFORE_RE.test(textBefore(text, m.index, 60))) continue;
        if (!ELIG_CONTEXT_RE.test(windowAround(text, m.index, m.length, 70, 70))) continue;
      }
      hits.push({ ...m, codes, excluded: EXCLUDED_BEFORE_RE.test(textBefore(text, m.index, 40)) });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const US_TOKEN = "(?<us>united\\s+states(?:\\s+of\\s+america)?|u\\.s\\.a?\\.?|usa|us)";
const US_RES: RegExp[] = [
  `${US_TOKEN}[- ]?(?:only|based|residents?|citizens?|citizenship|remote|work\\s+authori[sz]ation|persons?|nationals?)(?![a-z])`,
  `\\b(?:only|solely|exclusively)\\s+(?:in|within|for|to|from)\\s+(?:the\\s+)?${US_TOKEN}(?![a-z])`,
  `\\b(?:reside|residing|resident|residents|located|living|live|based|work|working|be|hired|hiring|employed)\\s+(?:in|within|from)\\s+(?:the\\s+)?(?:continental\\s+|contiguous\\s+)?${US_TOKEN}(?![a-z])`,
  `\\b(?:authori[sz]ed|eligible|eligibility|authori[sz]ation|permitted|legally\\s+able)\\s+to\\s+work\\s+in\\s+(?:the\\s+)?${US_TOKEN}(?![a-z])`,
  `${US_TOKEN}\\s*(?:\\(|-|–|—|:)?\\s*\\(?remote\\)?`,
  `\\bremote\\s*(?:\\(|-|–|—|:|in|within)?\\s*(?:the\\s+)?${US_TOKEN}(?![a-z])`,
  `\\bwithin\\s+the\\s+${US_TOKEN}(?![a-z])`,
  `\\b(?:green\\s+card|permanent\\s+resident)(?![a-z])`,
].map((s) => new RegExp(s, "gi"));

/** First US-only phrase; bare "us"/"usa" must be upper-case in the source so "join us" never matches. */
function usPhrase(text: string): TextMatch | null {
  let best: TextMatch | null = null;
  for (const re of US_RES) {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text))) {
      const token = m.groups?.us;
      if (token && !token.includes(".") && token.length <= 3 && token !== token.toUpperCase()) continue;
      if (!best || m.index < best.index) best = { index: m.index, length: m[0].length, text: m[0] };
      break;
    }
  }
  return best;
}

const GLOBAL_RE =
  /\bremote\s*[-–—(:]*\s*(?:global(?:ly)?|worldwide|anywhere|international)\b|\b(?:global(?:ly)?|worldwide)\s*[-–—):]*\s*remote\b|\b(?:work|working|hire|hiring|hires|candidates|applicants|applications|open|located|based|live|living|reside|residing)\s+(?:from|in|to)?\s*(?:anywhere|worldwide|globally|any\s+country|all\s+countries|any\s+location|everywhere)\b|\banywhere\s+in\s+the\s+world\b|\b(?:from|in)\s+any\s+(?:country|location|time\s*zone|timezone)\b|\bno\s+location\s+(?:restrictions?|requirements?|limits?)\b|\bopen\s+to\s+(?:all|any)\s+(?:countries|locations|regions)\b|\blocation\s*:\s*(?:anywhere|global|worldwide)\b/i;
const LOCATION_GLOBAL_RE = /^\s*(?:remote\s*[-–—(:]*\s*)?(?:global(?:ly)?|worldwide|anywhere|international)\s*\)?\s*(?:remote)?\s*$|\(\s*(?:global|worldwide|anywhere)\s*\)/i;
const LOCATION_REMOTE_STATE_RE = new RegExp(
  `^\\s*remote\\s*[-–—(:]*\\s*(?:in\\s+)?(${STATE_NAMES_SRC}|[A-Z]{2})\\s*\\)?\\s*$|^\\s*(${STATE_NAMES_SRC}|[A-Z]{2})\\s*[-–—(:,]*\\s*remote\\s*\\)?\\s*$`,
  "i",
);
const LOCATION_CITY_STATE_RE = /,\s*([A-Z]{2})(?:\s*,?\s*(?:USA?|United States|U\.S\.A?\.?))?\s*(?:\([^)]*\))?\s*$/;

const TZ_ABBR_RE = /\b(?:UTC|GMT|PST|PDT|EST|EDT|CST|CDT|MST|MDT|CET|CEST|EET|EEST|WET|BST|IST|AEST|AEDT|AWST|JST|SGT|HKT|AKST|HST|NZST|NZDT)(?![a-z])(?:\s*[+\-±]\s*\d{1,2}(?::\d{2})?)?/;
const TZ_NAMED_RE =
  /\b(?:pacific|eastern|central|mountain|european|central\s+european|british|indian|australian|japan(?:ese)?|u\.?s\.?|uk)\s+(?:standard\s+|daylight\s+|summer\s+)?time(?:\s*zones?)?\b|\btime\s*zones?\b|\btimezones?\b|\b(?:us|u\.s\.|uk|eu|european|american|pacific|eastern|central|north\s+american)\s+(?:business|working|office|core)\s+hours\b|\boverlap\w*\s+(?:of\s+|at\s+least\s+)?\d+\s*(?:hours?|hrs)\b/i;
const TZ_CONSTRAINT_RE =
  /\b(?:must|need|require\w*|overlap\w*|within|between|hours?|prefer\w*|located|based|only|core|working|work|available|availability|align\w*|time|zone)\b|[+\-±]\s*\d/i;

function sentenceAround(text: string, index: number, length: number): string {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1]!)) start--;
  let end = index + length;
  while (end < text.length && !/[.!?\n]/.test(text[end]!)) end++;
  return truncate(collapseWhitespace(text.slice(start, Math.min(text.length, end + 1))), 200);
}

export function parseTimezoneRequirement(text: string): string | null {
  const hit = findFirst(text, [TZ_ABBR_RE, TZ_NAMED_RE]);
  if (!hit) return null;
  const sentence = sentenceAround(text, hit.index, hit.length);
  return TZ_CONSTRAINT_RE.test(sentence) ? sentence : null;
}

export function parseGeographicEligibility(description: string, locationText: string | null): GeographyResult {
  const location = (locationText ?? "").trim();
  const timezoneRequirements = parseTimezoneRequirement(location ? `${location}\n${description}` : description);
  const result = (eligibility: GeographicEligibility, eligibleCountries: string[], evidence: string | null): GeographyResult => ({
    eligibility,
    eligibleCountries,
    timezoneRequirements,
    evidence,
  });

  // 1. State lists / exclusions in the description.
  for (const clause of findAll(description, STATE_CLAUSE_RE)) {
    const states = statesIn(clause.text);
    if (states.length) return result("US_SPECIFIC_STATES", states, snippet(description, clause.index, clause.length));
  }
  // 2. Location such as "Remote - Texas" / "Remote (CA)".
  const remoteState = location.match(LOCATION_REMOTE_STATE_RE);
  const stateToken = remoteState?.[1] ?? remoteState?.[2];
  if (stateToken) {
    const code = US_STATES[stateToken.toLowerCase()] ?? (STATE_ABBRS.has(stateToken) ? stateToken : null);
    if (code) return result("US_SPECIFIC_STATES", [`US-${code}`], location);
  }

  const locationUs =
    usPhrase(location) !== null ||
    /^\s*(?:remote\s*[-–—(:]*\s*)?(?:the\s+)?(?:united\s+states(?:\s+of\s+america)?|usa|u\.s\.a?\.?)\s*[)\-–—]*\s*(?:remote)?\s*\)?\s*$/i.test(location) ||
    (LOCATION_CITY_STATE_RE.test(location) && STATE_ABBRS.has(location.match(LOCATION_CITY_STATE_RE)?.[1] ?? "")) ||
    findAll(location, STATE_NAME_RE).length > 0;
  const descriptionUs = usPhrase(description);
  const locationPlaces = placeHits(location, false).filter((h) => !h.excluded);
  const descriptionPlaces = placeHits(description, true);
  const includedPlaces = descriptionPlaces.filter((h) => !h.excluded);
  const globalHit = findFirst(description, [GLOBAL_RE]);
  const locationGlobal = LOCATION_GLOBAL_RE.test(location);

  // 3. Named countries / regions (US added when the listing also says US).
  const countryHits = includedPlaces.length ? includedPlaces : globalHit ? [] : locationPlaces;
  if (countryHits.length) {
    const codes = uniqueStrings([...(locationUs || descriptionUs ? ["US"] : []), ...countryHits.flatMap((h) => h.codes)]);
    const first = countryHits[0]!;
    const evidence = includedPlaces.length ? snippet(description, first.index, first.length) : location;
    return result("COUNTRY_RESTRICTED", codes, evidence);
  }
  // 4. US only.
  if (descriptionUs) return result("US_ONLY", ["US"], snippet(description, descriptionUs.index, descriptionUs.length));
  if (locationUs) return result("US_ONLY", ["US"], location);
  // 5. Global.
  if (globalHit) return result("GLOBAL", [], snippet(description, globalHit.index, globalHit.length));
  if (locationGlobal) return result("GLOBAL", [], location);
  // Exclusion-only mentions ("not available in Canada") without a stated scope stay UNKNOWN but keep evidence.
  const excludedOnly = descriptionPlaces[0];
  if (excludedOnly) return result("UNKNOWN", [], snippet(description, excludedOnly.index, excludedOnly.length));
  return result("UNKNOWN", [], null);
}
