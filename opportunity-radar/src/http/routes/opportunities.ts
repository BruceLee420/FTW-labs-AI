import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { csv, json, noContent } from "../respond.ts";
import { queryToObject } from "../query.ts";
import { API } from "./index.ts";
import {
  EvaluateInputSchema,
  IngestUrlInputSchema,
  ManualOpportunityInputSchema,
  NoteInputSchema,
  OpportunityListQuerySchema,
  OpportunityPatchSchema,
  StatusChangeSchema,
} from "../../schemas/index.ts";
import { CsvImportSchema, JsonImportSchema } from "../../schemas/import.ts";
import { isValidId } from "../../utils/ids.ts";
import { notFound } from "../../utils/errors.ts";
import { addNote, changeStatus, createOpportunity, deleteOpportunity, getDetail, patchOpportunity } from "../../services/opportunities.ts";
import { ingestUrl } from "../../services/ingest/url.ts";
import { importCsv, importJson } from "../../services/ingest/import.ts";
import { evaluateOpportunity } from "../../services/evaluate.ts";
import { exportCsv } from "../../services/export.ts";
import { toSummary } from "../../services/summary.ts";
import { refreshFollowUpStatuses } from "../../services/applications.ts";

export function requireId(id: string | undefined): string {
  if (!id || !isValidId(id)) throw notFound("No such record.");
  return id;
}

export function registerOpportunityRoutes(router: Router, deps: AppDeps): void {
  const base = `${API}/opportunities`;

  router.get(base, (ctx) => {
    refreshFollowUpStatuses(deps);
    const query = OpportunityListQuerySchema.parse(queryToObject(ctx.url));
    const { items, total } = deps.repos.opportunities.list(query);
    return json({ items: items.map((o) => toSummary(deps, o)), total, limit: query.limit, offset: query.offset });
  });

  router.post(`${base}/manual`, async (ctx) => {
    const input = ManualOpportunityInputSchema.parse(await ctx.readJson());
    const created = createOpportunity(deps, input, ctx.actor);
    if (created.duplicate || !input.evaluate) return json(created, created.duplicate ? 200 : 201);
    const { opportunity, evaluation } = await evaluateOpportunity(deps, created.opportunity.id, { actor: ctx.actor });
    return json({ ...created, opportunity, evaluation }, 201);
  });

  router.post(
    `${base}/ingest-url`,
    async (ctx) => {
      const input = IngestUrlInputSchema.parse(await ctx.readJson());
      const result = await ingestUrl(deps, input, ctx.actor);
      if (result.duplicate || result.accessBlocked || !input.evaluate) return json(result, result.duplicate ? 200 : 201);
      const { opportunity, evaluation } = await evaluateOpportunity(deps, result.opportunity.id, { actor: ctx.actor });
      return json({ ...result, opportunity, evaluation }, 201);
    },
    { expensive: true },
  );

  router.post(
    `${base}/import`,
    async (ctx) => {
      const batch = JsonImportSchema.parse(await ctx.readJson());
      const result = importJson(deps, batch, ctx.actor);
      if (batch.evaluate) for (const item of result.items) if (!item.duplicate) await evaluateOpportunity(deps, item.id, { rulesOnly: true, actor: ctx.actor });
      return json(result, 201);
    },
    { expensive: true },
  );

  router.post(
    `${base}/import-csv`,
    async (ctx) => {
      const input = CsvImportSchema.parse(await ctx.readJson());
      const result = importCsv(deps, input.csv, input.sourceName, input.evaluate, ctx.actor);
      if (input.evaluate) for (const item of result.items) if (!item.duplicate) await evaluateOpportunity(deps, item.id, { rulesOnly: true, actor: ctx.actor });
      return json(result, 201);
    },
    { expensive: true },
  );

  router.get(`${API}/export.csv`, (ctx) => {
    const query = OpportunityListQuerySchema.parse(queryToObject(ctx.url));
    return csv(exportCsv(deps.repos, query), `opportunity-radar-${deps.now().slice(0, 10)}.csv`);
  });

  router.get(`${base}/:id`, (ctx) => json(getDetail(deps, requireId(ctx.params.id))));

  router.patch(`${base}/:id`, async (ctx) => {
    const patch = OpportunityPatchSchema.parse(await ctx.readJson());
    return json({ opportunity: patchOpportunity(deps, requireId(ctx.params.id), patch, ctx.actor) });
  });

  router.delete(`${base}/:id`, (ctx) => {
    deleteOpportunity(deps, requireId(ctx.params.id), ctx.actor);
    return noContent();
  });

  router.post(`${base}/:id/status`, async (ctx) => {
    const input = StatusChangeSchema.parse(await ctx.readJson());
    return json({ opportunity: changeStatus(deps, requireId(ctx.params.id), input.status, input.note, ctx.actor) });
  });

  router.post(`${base}/:id/notes`, async (ctx) => {
    const input = NoteInputSchema.parse(await ctx.readJson());
    return json(addNote(deps, requireId(ctx.params.id), input.note, ctx.actor));
  });

  router.post(
    `${base}/:id/evaluate`,
    async (ctx) => {
      const input = EvaluateInputSchema.parse(await ctx.readJson());
      return json(await evaluateOpportunity(deps, requireId(ctx.params.id), { rulesOnly: input.rulesOnly, actor: ctx.actor }));
    },
    { expensive: true },
  );
}
