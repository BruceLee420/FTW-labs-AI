import { existsSync } from "node:fs";
import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { json } from "../respond.ts";
import { API } from "./index.ts";
import { VERSION } from "../../version.ts";
import { buildSummary } from "../../services/summary.ts";

export function registerHealthRoutes(router: Router, deps: AppDeps): void {
  router.get(
    `${API}/health`,
    async () => {
      let dbOk = true;
      let counts: unknown = null;
      try {
        counts = deps.repos.opportunities.counts(deps.now());
      } catch (err) {
        dbOk = false;
        deps.logger.error("health: db check failed", { error: (err as Error)?.name });
      }
      const ai = await deps.ai.health();
      const resumes = deps.repos.resumes.listAll();
      return json({
        ok: dbOk,
        version: VERSION,
        time: deps.now(),
        db: { ok: dbOk },
        ai,
        resumes: {
          dirConfigured: deps.config.resumesDirConfigured,
          dirExists: existsSync(deps.config.resumesDir),
          indexedCount: resumes.length,
          activeCount: resumes.filter((r) => r.isActive).length,
        },
        counts,
        policy: "Advisory only. Opportunity Radar never submits applications or sends messages.",
      });
    },
    { public: true },
  );

  router.get(`${API}/summary`, async () => json(await buildSummary(deps)));

  router.get(`${API}/audit`, (ctx) => {
    const limit = Math.min(500, Math.max(1, Number(ctx.url.searchParams.get("limit") ?? 100) || 100));
    return json({ items: deps.repos.audit.listRecent(limit) });
  });
}
