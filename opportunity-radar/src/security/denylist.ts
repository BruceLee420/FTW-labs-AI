/**
 * Hosts the URL ingester refuses. These platforms prohibit automated access
 * in their terms; the product policy is to send the user to the employer's
 * own page instead. Cloud metadata hosts are here as a belt-and-braces SSRF
 * stop (the IP checks catch them too).
 */
export const BUILTIN_DENYLIST: { domain: string; reason: string }[] = [
  { domain: "linkedin.com", reason: "LinkedIn prohibits automated access; paste the details manually or use the employer's own career page." },
  { domain: "licdn.com", reason: "LinkedIn prohibits automated access; paste the details manually or use the employer's own career page." },
  { domain: "indeed.com", reason: "Indeed prohibits automated access; paste the details manually or use the employer's own career page." },
  { domain: "glassdoor.com", reason: "Glassdoor prohibits automated access; paste the details manually or use the employer's own career page." },
  { domain: "ziprecruiter.com", reason: "ZipRecruiter prohibits automated access; paste the details manually or use the employer's own career page." },
  { domain: "facebook.com", reason: "Facebook prohibits automated access; paste the details manually." },
  { domain: "instagram.com", reason: "Instagram prohibits automated access; paste the details manually." },
  { domain: "x.com", reason: "X prohibits automated access; paste the details manually." },
  { domain: "twitter.com", reason: "X/Twitter prohibits automated access; paste the details manually." },
  { domain: "metadata.google.internal", reason: "Cloud metadata endpoints are never fetched." },
  { domain: "instance-data", reason: "Cloud metadata endpoints are never fetched." },
];

export function denylistReason(hostname: string, extra: string[] = []): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const matches = (domain: string) => host === domain || host.endsWith("." + domain);
  for (const entry of BUILTIN_DENYLIST) if (matches(entry.domain)) return entry.reason;
  for (const d of extra) {
    const domain = d.toLowerCase().trim();
    if (domain && matches(domain)) return `${domain} is on your denylist (OPPORTUNITY_RADAR_URL_DENYLIST).`;
  }
  return null;
}
