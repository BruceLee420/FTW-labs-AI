/**
 * Duplicate detection. The repository returns candidates matched on any
 * indexed key; this module ranks them so the caller can keep the original
 * record and attach the new sighting as evidence instead of creating a copy.
 */
import type { DuplicateProbe, Repositories } from "../repositories/interfaces.ts";
import type { Opportunity } from "../types/entities.ts";
import { normalizeCompanyName, normalizeTitle, collapseWhitespace } from "../utils/text.ts";

export interface ProbeInput {
  canonicalUrl: string | null;
  sourceName: string;
  externalId: string | null;
  companyName: string;
  title: string;
  workMode: string;
  locationText: string | null;
  descriptionHash: string;
}

export interface DedupeMatch {
  opportunity: Opportunity;
  matchedOn: string[];
  confidence: "exact" | "strong" | "probable";
}

export function buildProbe(input: ProbeInput): DuplicateProbe {
  return {
    canonicalUrl: input.canonicalUrl,
    sourceName: input.sourceName,
    externalId: input.externalId,
    companyNameNormalized: normalizeCompanyName(input.companyName),
    titleNormalized: normalizeTitle(input.title),
    workMode: input.workMode,
    locationText: input.locationText,
    descriptionHash: input.descriptionHash,
  };
}

function locationKey(s: string | null): string {
  return s ? collapseWhitespace(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ")) : "";
}

/** Rank one candidate against the probe; null when it is not a real duplicate. */
export function rankCandidate(probe: DuplicateProbe, candidate: Opportunity): DedupeMatch | null {
  const matchedOn: string[] = [];
  if (probe.canonicalUrl && candidate.canonicalUrl && probe.canonicalUrl === candidate.canonicalUrl) {
    matchedOn.push("canonicalUrl");
  }
  if (
    probe.externalId &&
    candidate.externalId &&
    probe.externalId === candidate.externalId &&
    probe.sourceName.toLowerCase() === candidate.sourceName.toLowerCase()
  ) {
    matchedOn.push("externalId");
  }
  if (matchedOn.length) return { opportunity: candidate, matchedOn, confidence: "exact" };

  const sameCompany = probe.companyNameNormalized === normalizeCompanyName(candidate.companyName);
  const sameTitle = probe.titleNormalized === normalizeTitle(candidate.title);
  if (probe.descriptionHash && probe.descriptionHash === candidate.descriptionHash && sameCompany) {
    matchedOn.push("descriptionHash");
    return { opportunity: candidate, matchedOn, confidence: "strong" };
  }

  if (sameCompany && sameTitle) {
    const modeCompatible =
      probe.workMode === "UNKNOWN" || candidate.workMode === "UNKNOWN" || probe.workMode === candidate.workMode;
    const a = locationKey(probe.locationText);
    const b = locationKey(candidate.locationText);
    const locationCompatible = !a || !b || a === b || a.includes(b) || b.includes(a);
    if (modeCompatible && locationCompatible) {
      matchedOn.push("companyAndTitle");
      if (probe.workMode !== "UNKNOWN" && probe.workMode === candidate.workMode) matchedOn.push("workMode");
      if (a && a === b) matchedOn.push("location");
      return { opportunity: candidate, matchedOn, confidence: "probable" };
    }
  }
  return null;
}

const ORDER = { exact: 0, strong: 1, probable: 2 } as const;

export function findDuplicate(repos: Repositories, probe: DuplicateProbe): DedupeMatch | null {
  const matches = repos.opportunities
    .findDuplicateCandidates(probe)
    .map((c) => rankCandidate(probe, c))
    .filter((m): m is DedupeMatch => m !== null)
    .sort((x, y) => ORDER[x.confidence] - ORDER[y.confidence] || x.opportunity.createdAt.localeCompare(y.opportunity.createdAt));
  return matches[0] ?? null;
}
