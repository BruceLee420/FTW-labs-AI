/** URL helpers that do not touch the network. See security/ssrf.ts for fetching. */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
  "src",
  "referer",
  "referrer",
  "gh_src",
  "lever-source",
]);

/** Lowercase host, strip fragment/tracking params/default ports/trailing slash. */
export function canonicalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  let out = u.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith("/") && !u.search) out = out.replace(/\/$/, "");
  return out;
}

/** "https://jobs.example.co.uk/x" -> "example.co.uk" (best effort, no PSL). */
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const secondLevel = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
  const last = parts[parts.length - 1]!;
  const penultimate = parts[parts.length - 2]!;
  if (last.length === 2 && secondLevel.has(penultimate) && parts.length >= 3) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function domainOf(url: string | null | undefined): string | null {
  const h = hostnameOf(url);
  return h ? registrableDomain(h) : null;
}

/** Hosted ATS domains where the URL host is not the employer's own domain. */
export const HOSTED_ATS_DOMAINS: Record<string, string> = {
  "greenhouse.io": "Greenhouse",
  "lever.co": "Lever",
  "ashbyhq.com": "Ashby",
  "workable.com": "Workable",
  "myworkdayjobs.com": "Workday",
  "smartrecruiters.com": "SmartRecruiters",
  "bamboohr.com": "BambooHR",
  "jobvite.com": "Jobvite",
  "icims.com": "iCIMS",
  "recruitee.com": "Recruitee",
  "breezy.hr": "Breezy",
  "applytojob.com": "JazzHR",
  "rippling.com": "Rippling",
  "teamtailor.com": "Teamtailor",
  "successfactors.com": "SAP SuccessFactors",
  "taleo.net": "Taleo",
  "dover.com": "Dover",
  "pinpointhq.com": "Pinpoint",
};

export function hostedAtsName(url: string | null | undefined): string | null {
  const d = domainOf(url);
  return d ? (HOSTED_ATS_DOMAINS[d] ?? null) : null;
}
