/**
 * Paste-a-URL ingestion. One SSRF-safe GET, robots honoured, login walls and
 * CAPTCHAs respected (a stub record is created so the user can fill details
 * in by hand). Structured data comes from JSON-LD JobPosting when present,
 * then Open Graph / meta tags, then the page's readable text.
 */
import type { AppDeps } from "../../deps.ts";
import type { IngestUrlInput, ManualOpportunityInput } from "../../schemas/opportunity.ts";
import { ManualOpportunityInputSchema } from "../../schemas/opportunity.ts";
import type { EmploymentType, WorkMode } from "../../types/entities.ts";
import { extractCanonical, extractJsonLd, extractMeta, extractTitleTag, htmlToText } from "../../utils/html.ts";
import { canonicalizeUrl, domainOf, hostedAtsName, hostnameOf } from "../../utils/url.ts";
import { collapseWhitespace, truncate } from "../../utils/text.ts";
import { createOpportunity, type CreateResult } from "../opportunities.ts";
import { unprocessable } from "../../utils/errors.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "logger" | "fetcher">;

export interface ExtractedListing {
  method: "jsonld" | "meta" | "text" | "none";
  canonicalUrl: string | null;
  input: ManualOpportunityInput;
}

export interface IngestUrlResult extends CreateResult {
  accessBlocked: boolean;
  extracted: { method: ExtractedListing["method"]; canonicalUrl: string | null; finalUrl: string; status: number };
}

interface JobPostingLd {
  "@type"?: unknown;
  title?: unknown;
  description?: unknown;
  datePosted?: unknown;
  validThrough?: unknown;
  employmentType?: unknown;
  hiringOrganization?: { name?: unknown; sameAs?: unknown; url?: unknown } | string;
  jobLocation?: unknown;
  jobLocationType?: unknown;
  applicantLocationRequirements?: unknown;
  baseSalary?: unknown;
  url?: unknown;
  identifier?: { value?: unknown } | string;
  directApply?: unknown;
}

function str(v: unknown, max = 5000): string | null {
  if (typeof v === "string") return truncate(collapseWhitespace(v), max) || null;
  if (typeof v === "number") return String(v);
  return null;
}

/** Find a JobPosting object anywhere in the JSON-LD blocks (incl. @graph and arrays). */
export function findJobPosting(blocks: unknown[]): JobPostingLd | null {
  const stack = [...blocks];
  let guard = 0;
  while (stack.length && guard++ < 500) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return obj as JobPostingLd;
    if (obj["@graph"]) stack.push(obj["@graph"]);
    for (const v of Object.values(obj)) if (v && typeof v === "object") stack.push(v);
  }
  return null;
}

function locationFromLd(job: JobPostingLd): string | null {
  const locs = Array.isArray(job.jobLocation) ? job.jobLocation : job.jobLocation ? [job.jobLocation] : [];
  const parts: string[] = [];
  for (const l of locs) {
    if (typeof l === "string") parts.push(l);
    else if (l && typeof l === "object") {
      const addr = (l as { address?: Record<string, unknown> }).address;
      if (addr && typeof addr === "object") {
        parts.push(
          [addr.addressLocality, addr.addressRegion, addr.addressCountry]
            .map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "name" in x ? String((x as { name: unknown }).name) : ""))
            .filter(Boolean)
            .join(", "),
        );
      } else if ("name" in l) parts.push(String((l as { name: unknown }).name));
    }
  }
  const req = job.applicantLocationRequirements;
  const reqs = Array.isArray(req) ? req : req ? [req] : [];
  for (const r of reqs) if (r && typeof r === "object" && "name" in r) parts.push(`Applicants: ${String((r as { name: unknown }).name)}`);
  return parts.filter(Boolean).join(" · ") || null;
}

function employmentFromLd(v: unknown): EmploymentType | undefined {
  const s = (Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "").toUpperCase();
  if (!s) return undefined;
  if (s.includes("FULL")) return "FULL_TIME";
  if (s.includes("PART")) return "PART_TIME";
  if (s.includes("CONTRACT")) return "CONTRACT";
  if (s.includes("TEMP")) return "TEMPORARY";
  if (s.includes("INTERN")) return "INTERNSHIP";
  if (s.includes("FREELANCE")) return "FREELANCE";
  return undefined;
}

function salaryFromLd(v: unknown): { text: string; min: number | null; max: number | null; currency: string | null } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { currency?: unknown; value?: unknown };
  const val = o.value as { minValue?: unknown; maxValue?: unknown; value?: unknown; unitText?: unknown } | number | undefined;
  const currency = typeof o.currency === "string" ? o.currency.toUpperCase().slice(0, 3) : null;
  if (typeof val === "number") return { text: `${currency ?? ""} ${val}`.trim(), min: val, max: val, currency };
  if (val && typeof val === "object") {
    const min = typeof val.minValue === "number" ? val.minValue : typeof val.value === "number" ? val.value : null;
    const max = typeof val.maxValue === "number" ? val.maxValue : min;
    const unit = typeof val.unitText === "string" ? ` per ${val.unitText.toLowerCase()}` : "";
    return { text: `${currency ?? ""} ${min ?? ""}${max && max !== min ? `–${max}` : ""}${unit}`.trim(), min, max, currency };
  }
  return undefined;
}

export function extractListing(html: string, finalUrl: string, hint: { sourceName?: string; sourceType?: IngestUrlInput["sourceType"]; notes?: string }): ExtractedListing {
  const canonicalRaw = extractCanonical(html);
  const canonical = canonicalizeUrl(canonicalRaw ? new URL(canonicalRaw, finalUrl).toString() : finalUrl);
  const host = hostnameOf(finalUrl) ?? "unknown";
  const ats = hostedAtsName(finalUrl);
  const sourceType = hint.sourceType ?? (ats ? "OFFICIAL_ATS" : "MANUAL_URL");
  const sourceName = hint.sourceName ?? (ats ? `${ats.toLowerCase()}:${host}` : host);

  const job = findJobPosting(extractJsonLd(html));
  if (job) {
    const org = typeof job.hiringOrganization === "object" && job.hiringOrganization ? job.hiringOrganization : null;
    const companyName = str(org?.name, 200) ?? (typeof job.hiringOrganization === "string" ? job.hiringOrganization : null) ?? companyFromHost(host);
    const companyWebsite = str(org?.sameAs, 2048) ?? str(org?.url, 2048);
    const description = typeof job.description === "string" ? htmlToText(job.description) : "";
    const rawWorkMode: WorkMode | undefined = job.jobLocationType === "TELECOMMUTE" ? "REMOTE" : undefined;
    const identifier = typeof job.identifier === "object" && job.identifier ? str(job.identifier.value, 200) : str(job.identifier, 200);
    const input: ManualOpportunityInput = ManualOpportunityInputSchema.parse({
      companyName,
      title: str(job.title, 300) ?? extractTitleTag(html) ?? "Untitled listing",
      rawDescription: description || htmlToText(html),
      sourceName,
      sourceType,
      sourceUrl: finalUrl,
      canonicalUrl: canonical,
      applicationUrl: str(job.url, 2048) && /^https?:/i.test(String(job.url)) ? String(job.url) : finalUrl,
      externalId: identifier,
      companyWebsite: companyWebsite && /^https?:/i.test(companyWebsite) ? companyWebsite : null,
      employmentType: employmentFromLd(job.employmentType),
      workMode: rawWorkMode,
      locationText: locationFromLd(job),
      compensation: salaryFromLd(job.baseSalary),
      postedAt: str(job.datePosted, 40),
      closesAt: str(job.validThrough, 40),
      notes: hint.notes,
    });
    return { method: "jsonld", canonicalUrl: canonical, input };
  }

  const ogTitle = extractMeta(html, "og:title") ?? extractTitleTag(html);
  const description = htmlToText(html);
  const metaDescription = extractMeta(html, "description") ?? extractMeta(html, "og:description");
  const siteName = extractMeta(html, "og:site_name");
  const { title, company } = splitTitle(ogTitle ?? "", siteName);
  const input = ManualOpportunityInputSchema.parse({
    companyName: company ?? siteName ?? companyFromHost(host),
    title: title || "Untitled listing",
    rawDescription: description.length >= 200 ? description : [metaDescription ?? "", description].filter(Boolean).join("\n\n"),
    sourceName,
    sourceType,
    sourceUrl: finalUrl,
    canonicalUrl: canonical,
    applicationUrl: finalUrl,
    notes: hint.notes,
  });
  return { method: ogTitle ? "meta" : description ? "text" : "none", canonicalUrl: canonical, input };
}

function companyFromHost(host: string): string {
  const d = domainOf(`https://${host}`) ?? host;
  const base = d.split(".")[0] ?? d;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Unknown company";
}

/** "Senior Engineer - Acme" / "Senior Engineer | Acme Careers" / "Acme: Senior Engineer" */
export function splitTitle(raw: string, siteName: string | null): { title: string; company: string | null } {
  const t = collapseWhitespace(raw);
  if (!t) return { title: "", company: null };
  const cleaned = t.replace(/\b(careers?|jobs?|job posting|apply now|hiring)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  const seps = [" at ", " | ", " - ", " – ", " — ", ": "];
  for (const sep of seps) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0 && idx < cleaned.length - sep.length) {
      const a = cleaned.slice(0, idx).trim();
      const b = cleaned.slice(idx + sep.length).trim();
      if (sep === ": ") return { title: b, company: a };
      if (siteName && a.toLowerCase().includes(siteName.toLowerCase())) return { title: b, company: siteName };
      return { title: a, company: b || null };
    }
  }
  return { title: cleaned, company: null };
}

const BLOCK_MARKERS = /captcha|cf-chl|verify you are human|sign in to continue|log in to view|please log in|access denied/i;

export async function ingestUrl(deps: Deps, input: IngestUrlInput, actor = "user"): Promise<IngestUrlResult> {
  const response = await deps.fetcher(input.url, { acceptContentTypes: ["text/html", "application/xhtml+xml", "text/plain"] });
  const blocked = response.headers["x-radar-access-block"] === "login-or-captcha" || response.status === 401 || response.status === 403 || BLOCK_MARKERS.test(response.body.slice(0, 20000));
  if (!response.ok && !blocked) {
    throw unprocessable(`The page could not be fetched (HTTP ${response.status}).`);
  }
  const host = hostnameOf(response.finalUrl) ?? "unknown";
  if (blocked) {
    // Respect the wall: create a stub so the user can paste details manually.
    const stub = ManualOpportunityInputSchema.parse({
      companyName: companyFromHost(host),
      title: extractTitleTag(response.body) ?? "Listing behind a login or challenge",
      rawDescription: "",
      sourceName: input.sourceName ?? host,
      sourceType: input.sourceType ?? "MANUAL_URL",
      sourceUrl: response.finalUrl,
      applicationUrl: response.finalUrl,
      notes: [input.notes, "Page required a login or human verification; details must be entered manually."].filter(Boolean).join("\n"),
    });
    const created = createOpportunity(deps, stub, actor);
    return { ...created, accessBlocked: true, extracted: { method: "none", canonicalUrl: null, finalUrl: response.finalUrl, status: response.status } };
  }
  const extracted = extractListing(response.body, response.finalUrl, { sourceName: input.sourceName, sourceType: input.sourceType, notes: input.notes });
  const created = createOpportunity(deps, extracted.input, actor);
  return { ...created, accessBlocked: false, extracted: { method: extracted.method, canonicalUrl: extracted.canonicalUrl, finalUrl: response.finalUrl, status: response.status } };
}
