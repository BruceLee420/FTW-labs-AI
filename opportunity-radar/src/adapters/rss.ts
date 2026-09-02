/**
 * RSS 2.0 / Atom adapter for feeds the user is permitted to read. Small
 * regex-based parser (feeds are simple, well-formed documents); no external
 * XML dependency.
 */
import type { AdapterContext, AdapterFetchResult, AtsAdapter } from "./types.ts";
import type { ManualOpportunityInput } from "../schemas/opportunity.ts";
import { ManualOpportunityInputSchema } from "../schemas/opportunity.ts";
import { decodeEntities, htmlToText } from "../utils/html.ts";
import { hostnameOf } from "../utils/url.ts";
import { findRoleTitles } from "../services/resumes/skillsDictionary.ts";

interface FeedItem {
  title: string;
  link: string | null;
  content: string;
  published: string | null;
  id: string | null;
}

function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = re.exec(block);
  if (!m) return null;
  const inner = m[1]!.trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeEntities(cdata ? cdata[1]! : inner).trim();
}

function atomLink(block: string): string | null {
  const alternate = /<link[^>]*rel\s*=\s*["']alternate["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(block);
  if (alternate) return decodeEntities(alternate[1]!);
  const any = /<link[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block);
  return any ? decodeEntities(any[1]!) : null;
}

export function parseFeed(xml: string): { title: string | null; items: FeedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]!);
  const head = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i)[0] ?? "";
  const feedTitle = tag(head, "title");
  const items = blocks.map((b) => ({
    title: tag(b, "title") ?? "",
    link: isAtom ? atomLink(b) : tag(b, "link"),
    content: tag(b, "content:encoded") ?? tag(b, "content") ?? tag(b, "description") ?? tag(b, "summary") ?? "",
    published: tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date"),
    id: tag(b, "guid") ?? tag(b, "id"),
  }));
  return { title: feedTitle, items };
}

/** "Title at Company" | "Company: Title" | "Company - Title" | "Title - Company" */
export function splitFeedTitle(raw: string): { title: string; company: string | null } {
  const t = raw.replace(/\s+/g, " ").trim();
  let m = /^(.*?)\s+at\s+(.+)$/i.exec(t);
  if (m) return { title: m[1]!.trim(), company: m[2]!.trim() };
  m = /^([^:]{2,60}):\s+(.+)$/.exec(t);
  if (m) return { title: m[2]!.trim(), company: m[1]!.trim() };
  m = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(t);
  if (m) {
    const [a, b] = [m[1]!.trim(), m[2]!.trim()];
    const roleWords = /\b(engineer|developer|manager|designer|analyst|specialist|lead|director|assistant|coordinator|writer|nurse|representative|architect|scientist|consultant|intern|accountant|technician|clerk|officer|associate|executive|recruiter|teacher|editor)\b/i;
    const looksLikeRole = (t: string) => roleWords.test(t) || findRoleTitles(t, 1).length > 0;
    if (looksLikeRole(a) && !looksLikeRole(b)) return { title: a, company: b };
    if (looksLikeRole(b) && !looksLikeRole(a)) return { title: b, company: a };
    return { title: a, company: b };
  }
  return { title: t, company: null };
}

export class RssAdapter implements AtsAdapter {
  readonly id = "rss";
  readonly displayName = "RSS / Atom feed";
  readonly policyNote = "Reads a feed you are permitted to use (feeds are published for syndication). Only add feeds whose terms allow it; one fetch per sync, robots.txt honoured.";
  readonly targetHint = "feed URL you are permitted to read";

  validateTarget(target: string): string | null {
    try {
      const u = new URL(target);
      return u.protocol === "http:" || u.protocol === "https:" ? null : "Feed URL must be http(s).";
    } catch {
      return "Feed URL is not valid.";
    }
  }

  async fetch(target: string, ctx: AdapterContext): Promise<AdapterFetchResult> {
    const res = await ctx.fetcher(target, {
      acceptContentTypes: ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "application/rdf+xml", "text/html", "text/plain"],
    });
    if (!res.ok) throw new Error(`Feed returned ${res.status}`);
    const feed = parseFeed(res.body);
    const host = hostnameOf(res.finalUrl) ?? "feed";
    const sourceName = `rss:${host}`;
    const warnings: string[] = [];
    const items: ManualOpportunityInput[] = [];
    for (const it of feed.items) {
      if (!it.link || !it.title) {
        warnings.push(`Skipped an item without a link or title${it.title ? ` ("${it.title}")` : ""}.`);
        continue;
      }
      const { title, company } = splitFeedTitle(it.title);
      const parsed = ManualOpportunityInputSchema.safeParse({
        companyName: company ?? feed.title ?? "Unknown (see listing)",
        title,
        sourceName,
        sourceType: "RSS",
        sourceUrl: it.link,
        applicationUrl: it.link,
        externalId: it.id,
        rawDescription: htmlToText(it.content),
        postedAt: it.published && !Number.isNaN(Date.parse(it.published)) ? it.published : null,
      });
      if (!parsed.success) {
        warnings.push(`Skipped "${it.title}": ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        continue;
      }
      items.push(parsed.data);
    }
    return { sourceName, items, warnings };
  }
}
