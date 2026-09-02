import { existsSync } from "node:fs";
import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { json, noContent } from "../respond.ts";
import { API } from "./index.ts";
import { requireId } from "./opportunities.ts";
import { IndexResumesInputSchema, ResumePatchSchema } from "../../schemas/resume.ts";
import { indexResumeFolder } from "../../services/resumes/indexer.ts";
import { toResumeSummary } from "../../services/opportunities.ts";
import { recordAudit } from "../../services/audit.ts";
import { notFound } from "../../utils/errors.ts";

export function registerResumeRoutes(router: Router, deps: AppDeps): void {
  const base = `${API}/resumes`;

  router.get(base, () =>
    json({
      items: deps.repos.resumes.listAll().map(toResumeSummary),
      dirConfigured: deps.config.resumesDirConfigured,
      dirExists: existsSync(deps.config.resumesDir),
    }),
  );

  router.post(
    `${base}/index`,
    async (ctx) => {
      const input = IndexResumesInputSchema.parse(await ctx.readJson());
      return json(await indexResumeFolder(deps, { force: input.force }, ctx.actor));
    },
    { expensive: true },
  );

  router.patch(`${base}/:id`, async (ctx) => {
    const id = requireId(ctx.params.id);
    const patch = ResumePatchSchema.parse(await ctx.readJson());
    const updated = deps.repos.resumes.update(id, patch);
    if (!updated) throw notFound("No such résumé profile.");
    recordAudit(deps.repos, deps.now, "resume", id, "resume.updated", { fields: Object.keys(patch) }, ctx.actor);
    return json({ resume: toResumeSummary(updated) });
  });

  router.delete(`${base}/:id`, (ctx) => {
    const id = requireId(ctx.params.id);
    const existing = deps.repos.resumes.findById(id);
    if (!existing) throw notFound("No such résumé profile.");
    deps.repos.resumes.delete(id);
    recordAudit(deps.repos, deps.now, "resume", id, "resume.deleted", { filename: existing.filename }, ctx.actor);
    return noContent();
  });
}
