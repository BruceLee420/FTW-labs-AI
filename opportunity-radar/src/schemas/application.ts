import { z } from "zod";
import { IsoDateTimeSchema, MediumText, ShortText } from "./enums.ts";

export const GenerateDraftInputSchema = z.object({
  resumeId: z.string().trim().min(1).max(64).optional(),
  /** Free-text application questions the user wants concise answers drafted for. */
  questions: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  includeOutreach: z.boolean().default(false),
  /** Force the deterministic template even when a model is available. */
  templateOnly: z.boolean().default(false),
});
export type GenerateDraftInput = z.infer<typeof GenerateDraftInputSchema>;

const EvidenceEditSchema = z.object({
  claim: z.string().trim().max(1000),
  sourceFact: z.string().trim().max(1000),
  resumeId: z.string().trim().max(64),
  grounded: z.boolean(),
});

/** User edits to a draft; stored as a new version with generatedBy = "user". */
export const DraftEditSchema = z
  .object({
    professionalSummary: MediumText,
    coverLetter: z.string().trim().max(20000),
    resumeTailoringSuggestions: z.array(z.string().trim().max(1000)).max(50),
    applicationAnswers: z
      .array(z.object({ question: z.string().trim().max(500), answer: z.string().trim().max(5000) }))
      .max(20),
    recruiterOutreach: z.string().trim().max(5000).nullable(),
    evidence: z.array(EvidenceEditSchema).max(100),
  })
  .partial()
  .strict();
export type DraftEdit = z.infer<typeof DraftEditSchema>;

export const ApproveInputSchema = z.object({
  /** Approve a specific draft version; defaults to the latest package draft. */
  draftVersion: z.number().int().positive().optional(),
  /** Which résumé the user will submit (defaults to the draft's or recommended). */
  resumeId: z.string().trim().min(1).max(64).optional(),
  /** Explicit acknowledgement — the UI checkbox. Must be true. */
  acknowledged: z.literal(true),
});

export const MarkAppliedInputSchema = z.object({
  appliedAt: IsoDateTimeSchema.optional(),
  confirmationReference: ShortText.nullable().optional(),
  followUpDays: z.number().int().min(0).max(365).optional(),
  notes: MediumText.optional(),
});

/** Either `dueAt` or `days`; with neither, the default follow-up interval applies. */
export const ScheduleFollowUpInputSchema = z.object({
  dueAt: IsoDateTimeSchema.optional(),
  days: z.number().int().min(0).max(365).optional(),
  note: MediumText.optional(),
});

export const CompleteFollowUpInputSchema = z.object({
  sentAt: IsoDateTimeSchema.optional(),
  note: MediumText.optional(),
});

export const NoteInputSchema = z.object({ note: MediumText.min(1) });
