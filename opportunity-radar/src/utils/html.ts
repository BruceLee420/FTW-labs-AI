/** Small HTML helpers for extracting text and metadata from fetched pages. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Convert HTML to readable plain text with line breaks preserved for blocks. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Source whitespace (newlines between tags) is insignificant in HTML; only tags create breaks.
    .replace(/\s+/g, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|blockquote|pre|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}

export function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]!).replace(/\s+/g, " ").trim() || null : null;
}

/** <meta property="og:title" content="..."> or <meta name="description" content="..."> */
export function extractMeta(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta\\s+(?:[^>]*?\\s)?(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta\\s+(?:[^>]*?\\s)?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    "i",
  );
  const m = html.match(re) ?? html.match(re2);
  return m ? decodeEntities(m[1]!).trim() || null : null;
}

export function extractCanonical(html: string): string | null {
  const m =
    html.match(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i) ??
    html.match(/<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i);
  return m ? decodeEntities(m[1]!).trim() : null;
}

/** All <script type="application/ld+json"> bodies, parsed; invalid blocks skipped. */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const body = m[1]!.trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // Some sites embed HTML comments or trailing commas; try a light cleanup.
      try {
        out.push(JSON.parse(body.replace(/<!--[\s\S]*?-->/g, "").replace(/,\s*([}\]])/g, "$1")));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** Escape for safe interpolation into HTML attributes/text. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
