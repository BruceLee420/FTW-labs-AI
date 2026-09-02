/**
 * Ollama provider (local, default). Uses /api/tags for health and
 * /api/generate with `format` set to a JSON schema (or "json") so the model
 * is constrained to JSON. Prompts and responses are never logged.
 */
import type { AiHealth, AiProvider, GenerateOptions, GenerateResult } from "./provider.ts";
import { AiUnavailableError } from "./provider.ts";

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements AiProvider {
  readonly id = "ollama" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<AiHealth> {
    const checkedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) {
        return { provider: "ollama", model: this.model, reachable: false, modelAvailable: false, availableModels: [], message: `Ollama responded with HTTP ${res.status} at ${this.baseUrl}.`, checkedAt };
      }
      const data = (await res.json()) as { models?: { name?: string }[] };
      const names = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
      const available = names.some((n) => modelMatches(this.model, n));
      return {
        provider: "ollama",
        model: this.model,
        reachable: true,
        modelAvailable: available,
        availableModels: names,
        message: available ? `Ollama reachable; model ${this.model} available.` : `Ollama reachable but model ${this.model} is not pulled — run: ollama pull ${this.model}`,
        checkedAt,
      };
    } catch {
      return { provider: "ollama", model: this.model, reachable: false, modelAvailable: false, availableModels: [], message: `Ollama is not reachable at ${this.baseUrl}; start it with: ollama serve`, checkedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt,
          system: options.system,
          stream: false,
          format: options.jsonSchema ?? "json",
          options: { temperature: options.temperature ?? 0.2 },
          keep_alive: "5m",
        }),
      });
      if (!res.ok) throw new AiUnavailableError(`Ollama returned HTTP ${res.status}.`);
      const data = (await res.json()) as { response?: string; model?: string };
      return { text: data.response ?? "", model: data.model ?? this.model, provider: "ollama", durationMs: Date.now() - started };
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      if (controller.signal.aborted) throw new AiUnavailableError("The model did not respond before the timeout.");
      throw new AiUnavailableError(`Ollama is not reachable at ${this.baseUrl}.`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** "llama3.1" matches "llama3.1", "llama3.1:latest", "llama3.1:8b". */
export function modelMatches(configured: string, listed: string): boolean {
  if (configured === listed) return true;
  const base = configured.includes(":") ? configured : `${configured}:`;
  return listed.startsWith(base) || listed === `${configured}:latest`;
}
