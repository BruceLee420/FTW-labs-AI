/** Whole-dataset export/import and the explicit deletion path. */
import type { AppDeps } from "../deps.ts";
import type { z } from "zod";
import type { DataImportSchema, PurgeInputSchema } from "../schemas/import.ts";
import { recordAudit } from "./audit.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "logger">;

export interface DataExport {
  version: 1;
  exportedAt: string;
  opportunities: unknown[];
  applications: unknown[];
  drafts: unknown[];
  followUps: unknown[];
  evaluations: unknown[];
  audit: unknown[];
  /** Résumé metadata only — never extracted text. */
  resumes: unknown[];
}

export function exportData(deps: Deps): DataExport {
  const opportunities = deps.repos.opportunities.listAll();
  return {
    version: 1,
    exportedAt: deps.now(),
    opportunities,
    applications: deps.repos.applications.listAll(),
    drafts: deps.repos.drafts.listAll(),
    followUps: deps.repos.followUps.listAll(),
    evaluations: opportunities.flatMap((o) => deps.repos.evaluations.listForOpportunity(o.id)),
    audit: deps.repos.audit.listRecent(5000),
    resumes: deps.repos.resumes.listAll().map(({ extractedText, ...rest }) => ({ ...rest, extractedCharacters: extractedText.length })),
  };
}

/** Imports records verbatim (ids preserved); existing ids are skipped. */
export function importData(deps: Deps, payload: z.infer<typeof DataImportSchema>["export"], actor = "user") {
  const counts = { opportunities: 0, applications: 0, drafts: 0, followUps: 0, skipped: 0 };
  deps.repos.transaction(() => {
    for (const raw of payload.opportunities) {
      const o = raw as never as Parameters<typeof deps.repos.opportunities.insert>[0];
      if (!o?.id || !o.title || !o.companyName) {
        counts.skipped++;
        continue;
      }
      if (deps.repos.opportunities.findById(o.id)) {
        counts.skipped++;
        continue;
      }
      deps.repos.opportunities.insert(o);
      counts.opportunities++;
    }
    for (const raw of payload.applications) {
      const a = raw as never as Parameters<typeof deps.repos.applications.insert>[0];
      if (!a?.id || !a.opportunityId || deps.repos.applications.findById(a.id) || !deps.repos.opportunities.findById(a.opportunityId)) {
        counts.skipped++;
        continue;
      }
      deps.repos.applications.insert(a);
      counts.applications++;
    }
    for (const raw of payload.drafts) {
      const d = raw as never as Parameters<typeof deps.repos.drafts.insert>[0];
      if (!d?.id || !d.applicationId || deps.repos.drafts.findById(d.id) || !deps.repos.applications.findById(d.applicationId)) {
        counts.skipped++;
        continue;
      }
      deps.repos.drafts.insert(d);
      counts.drafts++;
    }
    for (const raw of payload.followUps) {
      const f = raw as never as Parameters<typeof deps.repos.followUps.insert>[0];
      if (!f?.id || !f.opportunityId || deps.repos.followUps.findById(f.id) || !deps.repos.opportunities.findById(f.opportunityId)) {
        counts.skipped++;
        continue;
      }
      deps.repos.followUps.insert(f);
      counts.followUps++;
    }
  });
  recordAudit(deps.repos, deps.now, "system", "data", "data.imported", counts, actor);
  return counts;
}

export function purgeData(deps: Deps, input: z.infer<typeof PurgeInputSchema>, actor = "user") {
  const deleted: Record<string, number> = {};
  deps.repos.transaction(() => {
    if (input.scope === "all" || input.scope === "drafts") deleted.drafts = deps.repos.drafts.deleteAll();
    if (input.scope === "all" || input.scope === "opportunities") {
      deleted.followUps = deps.repos.followUps.deleteAll();
      deleted.applications = deps.repos.applications.deleteAll();
      deleted.opportunities = deps.repos.opportunities.deleteAll();
    }
    if (input.scope === "all" || input.scope === "resumes") deleted.resumes = deps.repos.resumes.deleteAll();
    if (input.scope === "all") deleted.audit = deps.repos.audit.deleteAll();
  });
  recordAudit(deps.repos, deps.now, "system", "data", "data.purged", { scope: input.scope, ...deleted }, actor);
  deps.logger.info("data purged", { scope: input.scope, ...deleted });
  return deleted;
}
