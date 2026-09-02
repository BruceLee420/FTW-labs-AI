/**
 * AI provider abstraction. Local Ollama is the default; `none` disables AI.
 * Providers return raw text; the caller parses and validates against a zod
 * schema (see ./structured.ts). Providers must never log prompt contents,
 * because prompts can contain résumé facts.
 */

export interface AiHealth {
  provider: string;
  model: string | null;
  reachable: boolean;
  /** True when the configured model is present on the provider. */
  modelAvailable: boolean;
  availableModels: string[];
  message: string;
  checkedAt: string;
}

export interface GenerateOptions {
  /** JSON schema the provider may use to constrain output (Ollama `format`). */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  /** Overrides the provider default. */
  timeoutMs?: number;
  system?: string;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
}

export interface AiProvider {
  readonly id: "ollama" | "none";
  readonly model: string | null;
  health(): Promise<AiHealth>;
  /** Throws AiUnavailableError when the provider cannot be reached. */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export class AiInvalidOutputError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "AiInvalidOutputError";
    this.issues = issues;
  }
}
