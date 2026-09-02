/** Everything the services and routes need, injected once at startup (and by tests). */
import type { RadarConfig } from "./config.ts";
import type { Repositories } from "./repositories/interfaces.ts";
import type { AiProvider } from "./ai/provider.ts";
import type { SafeFetcher } from "./security/fetchTypes.ts";
import type { Logger } from "./logger.ts";
import type { AtsAdapter } from "./adapters/types.ts";

export interface AppDeps {
  config: RadarConfig;
  repos: Repositories;
  ai: AiProvider;
  fetcher: SafeFetcher;
  adapters: AtsAdapter[];
  logger: Logger;
  now: () => string;
}
