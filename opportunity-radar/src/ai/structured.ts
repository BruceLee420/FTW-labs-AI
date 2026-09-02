/**
 * Structured generation: call the provider, extract a JSON candidate from the
 * text, validate it with zod, and on failure retry ONCE with a repair prompt
 * carrying the validation issues. Never trusts raw model JSON.
 */
import { z } from "zod";
import type { AiProvider } from "./provider.ts";
import { AiInvalidOutputError } from "./provider.ts";
import { buildRepairPrompt } from "../prompts/repair.ts";

/** Strip code fences and return the first balanced {...} or [...] block. */
export function extractJsonCandidate(text: string): string | null {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  void close;
  return null;
}

export interface StructuredOptions {
  repairPrompt?: (issues: string[], raw: string) => string;
  temperature?: number;
  timeoutMs?: number;
  jsonSchema?: Record<string, unknown>;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  attempts: number;
  durationMs: number;
}

function tryParse<T>(schema: z.ZodType<T>, text: string): { ok: true; data: T } | { ok: false; issues: string[] } {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return { ok: false, issues: ["No JSON object found in the model output."] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, issues: [`Invalid JSON: ${(err as Error).message}`] };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export async function generateStructured<T>(
  provider: AiProvider,
  schema: z.ZodType<T>,
  prompt: { system: string; user: string },
  options: StructuredOptions = {},
): Promise<StructuredResult<T>> {
  let jsonSchema = options.jsonSchema;
  if (!jsonSchema) {
    try {
      jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    } catch {
      jsonSchema = undefined;
    }
  }
  const started = Date.now();
  const first = await provider.generate(prompt.user, { system: prompt.system, jsonSchema, temperature: options.temperature, timeoutMs: options.timeoutMs });
  const parsed = tryParse(schema, first.text);
  if (parsed.ok) return { data: parsed.data, model: first.model, attempts: 1, durationMs: Date.now() - started };

  const repair = (options.repairPrompt ?? buildRepairPrompt)(parsed.issues, first.text.slice(0, 4000));
  const second = await provider.generate(repair, { system: prompt.system, jsonSchema, temperature: 0, timeoutMs: options.timeoutMs });
  const reparsed = tryParse(schema, second.text);
  if (reparsed.ok) return { data: reparsed.data, model: second.model, attempts: 2, durationMs: Date.now() - started };
  throw new AiInvalidOutputError("Model output did not match the expected schema after a repair attempt.", reparsed.issues);
}
