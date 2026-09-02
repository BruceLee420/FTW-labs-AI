import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { json } from "../respond.ts";
import { API } from "./index.ts";
import { SettingsPatchSchema } from "../../schemas/import.ts";
import { safeConfigSummary } from "../../config.ts";
import { recordAudit } from "../../services/audit.ts";

const OVERRIDE_KEYS = ["followUpDays", "ollamaModel", "aiProvider"] as const;

export function registerSettingsRoutes(router: Router, deps: AppDeps): void {
  router.get(`${API}/settings`, async () => {
    const all = deps.repos.settings.all();
    const overrides = Object.fromEntries(OVERRIDE_KEYS.filter((k) => k in all).map((k) => [k, all[k]]));
    return json({ config: safeConfigSummary(deps.config), overrides, ai: await deps.ai.health() });
  });

  router.patch(`${API}/settings`, async (ctx) => {
    const patch = SettingsPatchSchema.parse(await ctx.readJson());
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) deps.repos.settings.set(k, v);
    recordAudit(deps.repos, deps.now, "system", "settings", "settings.updated", { fields: Object.keys(patch) }, ctx.actor);
    const all = deps.repos.settings.all();
    return json({ overrides: Object.fromEntries(OVERRIDE_KEYS.filter((k) => k in all).map((k) => [k, all[k]])) });
  });
}
