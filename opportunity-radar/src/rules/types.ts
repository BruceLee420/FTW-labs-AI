/**
 * Input contract for the deterministic rules layer.
 *
 * Rules run BEFORE any model call and must stay pure: they receive this
 * plain projection of an Opportunity (already normalised by the ingest and
 * normalise services) and return signals and scores without I/O. Keeping the
 * input narrow means the rules can be unit-tested with small literals and
 * reused by the evaluate service without a database or network.
 */
import type { Compensation, EmploymentType, GeographicEligibility, SourceType, WorkMode } from "../types/entities.ts";

export interface RuleInput {
  title: string;
  companyName: string;
  companyDomain: string | null;
  companyWebsite: string | null;
  officialCareerUrl: string | null;
  sourceUrl: string | null;
  applicationUrl: string | null;
  canonicalUrl: string | null;
  sourceType: SourceType;
  sourceName: string;
  description: string;
  locationText: string | null;
  workMode: WorkMode;
  geographicEligibility: GeographicEligibility;
  compensation: Compensation;
  postedAt: string | null;
  /** Optional so rule tests can omit it; UNKNOWN or absent counts as missing information. */
  employmentType?: EmploymentType;
}
