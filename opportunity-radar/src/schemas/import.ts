import { z } from "zod";
import { ManualOpportunityInputSchema } from "./opportunity.ts";
import { ShortText } from "./enums.ts";

/** POST /opportunities/import — a batch from an approved source. */
export const JsonImportSchema = z.object({
  sourceName: ShortText.min(1),
  items: z.array(ManualOpportunityInputSchema.omit({ evaluate: true })).min(1).max(500),
  evaluate: z.boolean().default(true),
});
export type JsonImport = z.infer<typeof JsonImportSchema>;

export const CsvImportSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  sourceName: ShortText.default("csv-import"),
  evaluate: z.boolean().default(false),
});

export const SourceSyncInputSchema = z.object({
  adapterId: z.string().trim().min(1).max(64),
  /** Adapter-specific target: a Greenhouse board token, an RSS URL, a mock fixture name. */
  target: z.string().trim().min(1).max(2048),
  evaluate: z.boolean().default(true),
});

export const SettingsPatchSchema = z
  .object({
    followUpDays: z.number().int().min(0).max(365),
    ollamaModel: z.string().trim().min(1).max(120),
    aiProvider: z.enum(["ollama", "none"]),
  })
  .partial()
  .strict();

export const PurgeInputSchema = z.object({
  /** Must equal "DELETE EVERYTHING" — a typed confirmation, not a checkbox. */
  confirm: z.literal("DELETE EVERYTHING"),
  scope: z.enum(["all", "opportunities", "resumes", "drafts"]).default("all"),
});

export const DataImportSchema = z.object({
  /** A previous export.json payload. */
  export: z.object({
    version: z.literal(1),
    opportunities: z.array(z.record(z.string(), z.unknown())).max(50_000),
    applications: z.array(z.record(z.string(), z.unknown())).max(50_000).default([]),
    drafts: z.array(z.record(z.string(), z.unknown())).max(50_000).default([]),
    followUps: z.array(z.record(z.string(), z.unknown())).max(50_000).default([]),
  }),
});
