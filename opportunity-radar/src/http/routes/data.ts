import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { json } from "../respond.ts";
import { API } from "./index.ts";
import { DataImportSchema, PurgeInputSchema } from "../../schemas/import.ts";
import { exportData, importData, purgeData } from "../../services/data.ts";

export function registerDataRoutes(router: Router, deps: AppDeps): void {
  router.get(`${API}/data/export.json`, () =>
    json(exportData(deps), 200, { "Content-Disposition": `attachment; filename="opportunity-radar-export-${deps.now().slice(0, 10)}.json"` }),
  );

  router.post(
    `${API}/data/import`,
    async (ctx) => {
      const input = DataImportSchema.parse(await ctx.readJson());
      return json({ imported: importData(deps, input.export, ctx.actor) });
    },
    { expensive: true },
  );

  router.post(`${API}/data/purge`, async (ctx) => {
    const input = PurgeInputSchema.parse(await ctx.readJson());
    return json({ deleted: purgeData(deps, input, ctx.actor) });
  });
}
