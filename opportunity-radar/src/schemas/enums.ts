import { z } from "zod";
import {
  AI_STATUSES,
  APPLICATION_STATUSES,
  COMPENSATION_PERIODS,
  DRAFT_KINDS,
  EMPLOYMENT_TYPES,
  EXTRACTION_STATUSES,
  FOLLOW_UP_STATUSES,
  GEOGRAPHIC_ELIGIBILITIES,
  OPPORTUNITY_STATUSES,
  RESUME_FORMATS,
  SOURCE_TYPES,
  SYNC_RUN_STATUSES,
  VERIFICATION_STATUSES,
  WORK_MODES,
} from "../types/entities.ts";

export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export const WorkModeSchema = z.enum(WORK_MODES);
export const EmploymentTypeSchema = z.enum(EMPLOYMENT_TYPES);
export const GeographicEligibilitySchema = z.enum(GEOGRAPHIC_ELIGIBILITIES);
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export const OpportunityStatusSchema = z.enum(OPPORTUNITY_STATUSES);
export const CompensationPeriodSchema = z.enum(COMPENSATION_PERIODS);
export const AiStatusSchema = z.enum(AI_STATUSES);
export const ExtractionStatusSchema = z.enum(EXTRACTION_STATUSES);
export const ResumeFormatSchema = z.enum(RESUME_FORMATS);
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export const DraftKindSchema = z.enum(DRAFT_KINDS);
export const FollowUpStatusSchema = z.enum(FOLLOW_UP_STATUSES);
export const SyncRunStatusSchema = z.enum(SYNC_RUN_STATUSES);

/** Score in the closed range 0–100, rounded to an integer. */
export const ScoreSchema = z.number().min(0).max(100).transform((n) => Math.round(n));

/** ISO-8601 date-time. Accepts a date-only string and normalises to midnight UTC. */
export const IsoDateTimeSchema = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date")
  .transform((s) => new Date(s).toISOString());

export const HttpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((s) => /^https?:\/\//i.test(s), "Only http(s) URLs are accepted")
  .refine((s) => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }, "Invalid URL");

export const ShortText = z.string().trim().max(300);
export const MediumText = z.string().trim().max(5000);
export const LongText = z.string().trim().max(60000);
export const StringList = z.array(z.string().trim().min(1).max(200)).max(100);
