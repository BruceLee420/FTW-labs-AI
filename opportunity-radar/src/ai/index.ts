import type { RadarConfig } from "../config.ts";
import type { AiProvider } from "./provider.ts";
import { OllamaProvider } from "./ollama.ts";
import { NoneProvider } from "./none.ts";

export function createAiProvider(config: Pick<RadarConfig, "aiProvider" | "ollamaBaseUrl" | "ollamaModel" | "aiTimeoutMs">, fetchImpl?: typeof fetch): AiProvider {
  if (config.aiProvider === "none") return new NoneProvider();
  return new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, timeoutMs: config.aiTimeoutMs, fetchImpl });
}
