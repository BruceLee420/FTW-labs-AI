/**
 * Strict schemas for everything a model returns. Raw model JSON is never
 * trusted: it is parsed, validated here, and rejected (with one repair retry)
 * when it does not conform. Keep these tolerant of harmless variations
 * (numbers as strings, missing optional arrays) but strict about shape.
 */
import { z } from "zod";

const LooseScore = z
  .union([z.number(), z.string().regex(/^\s*-?\d+(\.\d+)?\s*$/)])
  .transform((v) => Math.max(0, Math.min(100, Math.round(Number(v)))));

const LooseStringList = z
  .array(z.union([z.string(), z.number()]))
  .max(50)
  .transform((a) => a.map((s) => String(s).trim()).filter(Boolean));

const Confidence = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.enum(["low", "medium", "high"]))
  .catch("low");

export const AiEvaluationSchema = z.object({
  legitimacyScore: LooseScore,
  scamRiskScore: LooseScore,
  relevanceScore: LooseScore,
  remoteEligibilityScore: LooseScore,
  bestResumeId: z.union([z.string(), z.null()]).transform((s) => (s && s.trim() ? s.trim() : null)).default(null),
  rationale: z.string().trim().min(1).max(4000),
  evidence: z
    .array(
      z.object({
        claim: z.string().trim().max(1000),
        reference: z.string().trim().max(1000),
      }),
    )
    .max(30)
    .default([]),
  riskSignals: LooseStringList.default([]),
  missingInformation: LooseStringList.default([]),
  suggestedNextAction: z.string().trim().max(500).default("Review manually."),
  confidence: Confidence.default("low"),
});
export type AiEvaluationOutput = z.infer<typeof AiEvaluationSchema>;

export const DraftEvidenceSchema = z.object({
  claim: z.string().trim().max(1000),
  sourceFact: z.string().trim().max(1000),
});

export const DraftPackageOutputSchema = z.object({
  professionalSummary: z.string().trim().min(1).max(3000),
  coverLetter: z.string().trim().min(1).max(12000),
  resumeTailoringSuggestions: LooseStringList.default([]),
  applicationAnswers: z
    .array(z.object({ question: z.string().trim().max(500), answer: z.string().trim().max(4000) }))
    .max(20)
    .default([]),
  recruiterOutreach: z.union([z.string().trim().max(4000), z.null()]).default(null),
  evidence: z.array(DraftEvidenceSchema).max(60).default([]),
});
export type DraftPackageOutput = z.infer<typeof DraftPackageOutputSchema>;

export const FollowUpEmailOutputSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(6000),
  evidence: z.array(DraftEvidenceSchema).max(20).default([]),
});
export type FollowUpEmailOutput = z.infer<typeof FollowUpEmailOutputSchema>;
