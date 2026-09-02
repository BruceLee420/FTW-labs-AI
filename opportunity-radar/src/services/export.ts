/** CSV export with the fixed tracking columns. */
import type { Repositories } from "../repositories/interfaces.ts";
import type { OpportunityListQuery } from "../schemas/opportunity.ts";
import type { Application, Opportunity, ResumeProfile } from "../types/entities.ts";
import { toCsv } from "../utils/csv.ts";
import { isoDate } from "../utils/time.ts";

export const EXPORT_COLUMNS = [
  "Company Name",
  "Position Title",
  "Employment Type",
  "Work Mode",
  "Location / Eligibility",
  "Source Name",
  "Source URL",
  "Application URL",
  "Date Found",
  "Date Posted",
  "Verification Status",
  "Legitimacy Score",
  "Scam Risk Score",
  "Relevance Score",
  "Recommended Résumé",
  "Date Applied",
  "Follow-Up Due Date",
  "Follow-Up Sent Date",
  "Current Status",
  "Notes",
] as const;

export function locationEligibility(o: Pick<Opportunity, "locationText" | "geographicEligibility" | "eligibleCountries">): string {
  const parts = [o.locationText?.trim() || "", o.geographicEligibility.replace(/_/g, " ").toLowerCase()];
  if (o.eligibleCountries.length) parts.push(o.eligibleCountries.join(" "));
  return parts.filter(Boolean).join(" / ");
}

export function exportRow(
  o: Opportunity,
  application: Application | null,
  resume: ResumeProfile | null,
): unknown[] {
  return [
    o.companyName,
    o.title,
    o.employmentType,
    o.workMode,
    locationEligibility(o),
    o.sourceName,
    o.sourceUrl ?? "",
    o.applicationUrl ?? "",
    isoDate(o.discoveredAt),
    isoDate(o.postedAt),
    o.verificationStatus,
    o.legitimacyScore ?? "",
    o.scamRiskScore ?? "",
    o.relevanceScore ?? "",
    resume?.label ?? "",
    isoDate(application?.appliedAt ?? null),
    isoDate(application?.followUpDueAt ?? o.followUpDueAt),
    isoDate(application?.followUpSentAt ?? null),
    o.status,
    o.notes,
  ];
}

export function exportCsv(repos: Repositories, query: OpportunityListQuery): string {
  const { items } = repos.opportunities.list({ ...query, limit: 500, offset: 0 });
  const all = collectAll(repos, query, items);
  const resumes = new Map(repos.resumes.listAll().map((r) => [r.id, r]));
  const rows = all.map((o) =>
    exportRow(o, repos.applications.findByOpportunity(o.id), o.recommendedResumeId ? (resumes.get(o.recommendedResumeId) ?? null) : null),
  );
  return toCsv([...EXPORT_COLUMNS], rows);
}

/** Page through the filtered set so exports are complete, not capped at one page. */
function collectAll(repos: Repositories, query: OpportunityListQuery, first: Opportunity[]): Opportunity[] {
  const out = [...first];
  let offset = first.length;
  for (let guard = 0; guard < 200 && first.length === 500; guard++) {
    const page = repos.opportunities.list({ ...query, limit: 500, offset }).items;
    if (!page.length) break;
    out.push(...page);
    offset += page.length;
    if (page.length < 500) break;
  }
  return out;
}
