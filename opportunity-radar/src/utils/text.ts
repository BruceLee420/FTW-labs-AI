/** Text normalisation helpers shared by dedup, matching and rules. */

const COMPANY_SUFFIXES =
  /\b(incorporated|inc|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|gmbh|ag|sa|s\.a|bv|b\.v|pty|llp|lp|holdings|group|technologies|technology|labs)\b\.?/g;

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Lowercase, ASCII-fold, strip punctuation and legal suffixes. */
export function normalizeCompanyName(name: string): string {
  return collapseWhitespace(
    stripDiacritics(name)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(COMPANY_SUFFIXES, " "),
  );
}

const TITLE_NOISE =
  /\b(remote|hybrid|onsite|on-site|us|usa|united states|full[- ]time|part[- ]time|contract|contractor|urgent|hiring|now|immediate|immediately|wfh|work from home|\d{4,}|[ivx]+)\b/g;

/** Lowercase, punctuation-free, common job-title noise removed. */
export function normalizeTitle(title: string): string {
  return collapseWhitespace(
    stripDiacritics(title)
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, " ")
      .replace(/[^a-z0-9\s+#.]/g, " ")
      .replace(TITLE_NOISE, " "),
  );
}

/** Tokens of 2+ chars, lowercased, ASCII-folded. Keeps "c++", "c#", ".net", "node.js". */
export function tokenize(s: string): string[] {
  return stripDiacritics(s)
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length >= 2);
}

export function uniqueStrings(list: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = collapseWhitespace(raw);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Split description text into trimmed, non-empty lines. */
export function lines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•\-–—*·▪◦]+/, "").trim())
    .filter(Boolean);
}
