/** Provider used when AI is disabled. Everything else keeps working. */
import type { AiHealth, AiProvider, GenerateResult } from "./provider.ts";
import { AiUnavailableError } from "./provider.ts";

export class NoneProvider implements AiProvider {
  readonly id = "none" as const;
  readonly model = null;
  async health(): Promise<AiHealth> {
    return {
      provider: "none",
      model: null,
      reachable: false,
      modelAvailable: false,
      availableModels: [],
      message: "AI disabled (OPPORTUNITY_RADAR_AI_PROVIDER=none); rules-only evaluation and manual tracking remain available.",
      checkedAt: new Date().toISOString(),
    };
  }
  async generate(): Promise<GenerateResult> {
    throw new AiUnavailableError("AI is disabled.");
  }
}
