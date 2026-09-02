import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { json } from "../respond.ts";
import { API } from "./index.ts";
import { SourceSyncInputSchema } from "../../schemas/import.ts";
import { syncSource } from "../../services/ingest/sync.ts";

export function registerSourceRoutes(router: Router, deps: AppDeps): void {
  router.get(`${API}/sources`, () =>
    json({
      adapters: deps.adapters.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        policyNote: a.policyNote,
        targetHint: a.targetHint,
        suggestedTargets: a.id === "greenhouse" ? deps.config.greenhouseBoards : a.id === "rss" ? deps.config.rssFeeds : a.id === "mock" ? ["sample"] : [],
      })),
      recentRuns: deps.repos.syncRuns.listRecent(20),
    }),
  );

  router.post(
    `${API}/sources/sync`,
    async (ctx) => {
      const input = SourceSyncInputSchema.parse(await ctx.readJson());
      const result = await syncSource(deps, input.adapterId, input.target, ctx.actor);
      return json(result, result.run.status === "FAILED" ? 502 : 200);
    },
    { expensive: true },
  );
}
