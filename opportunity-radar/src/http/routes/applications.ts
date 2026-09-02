import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { json } from "../respond.ts";
import { API } from "./index.ts";
import { requireId } from "./opportunities.ts";
import {
  ApproveInputSchema,
  CompleteFollowUpInputSchema,
  DraftEditSchema,
  GenerateDraftInputSchema,
  MarkAppliedInputSchema,
  ScheduleFollowUpInputSchema,
} from "../../schemas/application.ts";
import { approveApplication, completeFollowUp, markApplied, scheduleFollowUp } from "../../services/applications.ts";
import { editDraft, generateDraftPackage, generateFollowUpDraft } from "../../services/drafts.ts";

export function registerApplicationRoutes(router: Router, deps: AppDeps): void {
  const base = `${API}/opportunities/:id`;

  router.post(
    `${base}/generate-draft`,
    async (ctx) => {
      const input = GenerateDraftInputSchema.parse(await ctx.readJson());
      return json(await generateDraftPackage(deps, requireId(ctx.params.id), input, ctx.actor), 201);
    },
    { expensive: true },
  );

  router.patch(`${base}/drafts/:draftId`, async (ctx) => {
    const edit = DraftEditSchema.parse(await ctx.readJson());
    return json({ draft: editDraft(deps, requireId(ctx.params.id), requireId(ctx.params.draftId), edit, ctx.actor) });
  });

  router.post(`${base}/approve`, async (ctx) => {
    const input = ApproveInputSchema.parse(await ctx.readJson());
    return json(approveApplication(deps, requireId(ctx.params.id), input));
  });

  router.post(`${base}/mark-applied`, async (ctx) => {
    const input = MarkAppliedInputSchema.parse(await ctx.readJson());
    return json(markApplied(deps, requireId(ctx.params.id), input));
  });

  router.post(`${base}/schedule-follow-up`, async (ctx) => {
    const input = ScheduleFollowUpInputSchema.parse(await ctx.readJson());
    return json(scheduleFollowUp(deps, requireId(ctx.params.id), input));
  });

  router.post(
    `${base}/follow-up-draft`,
    async (ctx) => {
      await ctx.readJson();
      return json({ draft: await generateFollowUpDraft(deps, requireId(ctx.params.id), ctx.actor) }, 201);
    },
    { expensive: true },
  );

  router.post(`${base}/complete-follow-up`, async (ctx) => {
    const input = CompleteFollowUpInputSchema.parse(await ctx.readJson());
    return json(completeFollowUp(deps, requireId(ctx.params.id), input));
  });
}
