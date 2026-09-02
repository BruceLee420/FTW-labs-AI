import { z } from "zod";
import {
  CompensationPeriodSchema,
  EmploymentTypeSchema,
  GeographicEligibilitySchema,
  HttpUrlSchema,
  IsoDateTimeSchema,
  LongText,
  MediumText,
  OpportunityStatusSchema,
  ShortText,
  SourceTypeSchema,
  StringList,
  VerificationStatusSchema,
  WorkModeSchema,
} from "./enums.ts";

export const CompensationInputSchema = z.object({
  text: ShortText.nullable().optional(),
  min: z.number().nonnegative().nullable().optional(),
  max: z.number().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  period: CompensationPeriodSchema.optional(),
});

/** Body for POST /opportunities/manual and for each JSON-import item. */
export const ManualOpportunityInputSchema = z.object({
  companyName: ShortText.min(1),
  title: ShortText.min(1),
  rawDescription: LongText.default(""),
  sourceName: ShortText.default("manual"),
  sourceType: SourceTypeSchema.default("MANUAL_URL"),
  sourceUrl: HttpUrlSchema.nullable().optional(),
  applicationUrl: HttpUrlSchema.nullable().optional(),
  canonicalUrl: HttpUrlSchema.nullable().optional(),
  externalId: ShortText.nullable().optional(),
  companyWebsite: HttpUrlSchema.nullable().optional(),
  officialCareerUrl: HttpUrlSchema.nullable().optional(),
  employmentType: EmploymentTypeSchema.optional(),
  workMode: WorkModeSchema.optional(),
  locationText: ShortText.nullable().optional(),
  geographicEligibility: GeographicEligibilitySchema.optional(),
  eligibleCountries: StringList.optional(),
  timezoneRequirements: ShortText.nullable().optional(),
  requiredSkills: StringList.optional(),
  preferredSkills: StringList.optional(),
  compensation: CompensationInputSchema.optional(),
  postedAt: IsoDateTimeSchema.nullable().optional(),
  closesAt: IsoDateTimeSchema.nullable().optional(),
  notes: MediumText.optional(),
  /** Skip the deterministic evaluation on create (still normalises). */
  evaluate: z.boolean().default(true),
});
export type ManualOpportunityInput = z.infer<typeof ManualOpportunityInputSchema>;

export const IngestUrlInputSchema = z.object({
  url: HttpUrlSchema,
  sourceName: ShortText.optional(),
  sourceType: SourceTypeSchema.optional(),
  notes: MediumText.optional(),
  evaluate: z.boolean().default(true),
});
export type IngestUrlInput = z.infer<typeof IngestUrlInputSchema>;

/** Body for PATCH /opportunities/:id — every field optional; unknown keys rejected. */
export const OpportunityPatchSchema = z
  .object({
    companyName: ShortText.min(1),
    title: ShortText.min(1),
    rawDescription: LongText,
    sourceName: ShortText,
    sourceType: SourceTypeSchema,
    sourceUrl: HttpUrlSchema.nullable(),
    applicationUrl: HttpUrlSchema.nullable(),
    canonicalUrl: HttpUrlSchema.nullable(),
    companyWebsite: HttpUrlSchema.nullable(),
    officialCareerUrl: HttpUrlSchema.nullable(),
    companyDomain: ShortText.nullable(),
    employmentType: EmploymentTypeSchema,
    workMode: WorkModeSchema,
    locationText: ShortText.nullable(),
    geographicEligibility: GeographicEligibilitySchema,
    eligibleCountries: StringList,
    timezoneRequirements: ShortText.nullable(),
    responsibilities: StringList,
    qualifications: StringList,
    requiredSkills: StringList,
    preferredSkills: StringList,
    compensation: CompensationInputSchema,
    postedAt: IsoDateTimeSchema.nullable(),
    closesAt: IsoDateTimeSchema.nullable(),
    status: OpportunityStatusSchema,
    verificationStatus: VerificationStatusSchema,
    verificationReasons: StringList,
    recommendedResumeId: z.string().trim().min(1).max(64).nullable(),
    nextAction: ShortText.nullable(),
    notes: MediumText,
    /** Re-run normalisation from rawDescription after applying the patch. */
    renormalize: z.boolean(),
  })
  .partial()
  .strict();
export type OpportunityPatch = z.infer<typeof OpportunityPatchSchema>;

export const OpportunityListQuerySchema = z.object({
  status: z.array(OpportunityStatusSchema).optional(),
  sourceType: z.array(SourceTypeSchema).optional(),
  sourceName: ShortText.optional(),
  workMode: z.array(WorkModeSchema).optional(),
  geographicEligibility: z.array(GeographicEligibilitySchema).optional(),
  verificationStatus: z.array(VerificationStatusSchema).optional(),
  minLegitimacy: z.coerce.number().min(0).max(100).optional(),
  minRelevance: z.coerce.number().min(0).max(100).optional(),
  maxScamRisk: z.coerce.number().min(0).max(100).optional(),
  discoveredAfter: IsoDateTimeSchema.optional(),
  discoveredBefore: IsoDateTimeSchema.optional(),
  search: z.string().trim().max(200).optional(),
  sort: z
    .enum([
      "discoveredAt",
      "postedAt",
      "updatedAt",
      "relevanceScore",
      "legitimacyScore",
      "scamRiskScore",
      "companyName",
      "title",
      "followUpDueAt",
    ])
    .default("discoveredAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type OpportunityListQuery = z.infer<typeof OpportunityListQuerySchema>;

export const EvaluateInputSchema = z.object({
  /** Skip the model even if it is available (rules only). */
  rulesOnly: z.boolean().default(false),
});

export const StatusChangeSchema = z.object({
  status: OpportunityStatusSchema,
  note: MediumText.optional(),
});
