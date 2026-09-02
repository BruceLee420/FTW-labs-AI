/** Registers every route. Path prefix: /api/opportunity-radar. */
import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { registerHealthRoutes } from "./health.ts";
import { registerOpportunityRoutes } from "./opportunities.ts";
import { registerApplicationRoutes } from "./applications.ts";
import { registerResumeRoutes } from "./resumes.ts";
import { registerSourceRoutes } from "./sources.ts";
import { registerSettingsRoutes } from "./settings.ts";
import { registerDataRoutes } from "./data.ts";
import { registerPageRoutes } from "./pages.ts";

export const API = "/api/opportunity-radar";

export function registerRoutes(router: Router, deps: AppDeps): void {
  registerHealthRoutes(router, deps);
  registerOpportunityRoutes(router, deps);
  registerApplicationRoutes(router, deps);
  registerResumeRoutes(router, deps);
  registerSourceRoutes(router, deps);
  registerSettingsRoutes(router, deps);
  registerDataRoutes(router, deps);
  registerPageRoutes(router, deps);
}
