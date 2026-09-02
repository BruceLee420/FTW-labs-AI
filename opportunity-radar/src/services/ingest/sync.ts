/** Run one source adapter on demand and record a SourceSyncRun. Never scheduled. */
import type { AppDeps } from "../../deps.ts";
import type { SourceSyncRun } from "../../types/entities.ts";
import { findAdapter } from "../../adapters/registry.ts";
import { notFound, unprocessable } from "../../utils/errors.ts";
import { newId } from "../../utils/ids.ts";
import { recordAudit } from "../audit.ts";
import { createOpportunity } from "../opportunities.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "logger" | "fetcher" | "adapters">;

export interface SyncResult {
  run: SourceSyncRun;
  created: number;
  duplicates: number;
  warnings: string[];
  items: { id: string; duplicate: boolean; title: string }[];
}

export async function syncSource(deps: Deps, adapterId: string, target: string, actor = "user"): Promise<SyncResult> {
  const adapter = findAdapter(deps.adapters, adapterId);
  if (!adapter) throw notFound("No such source adapter.");
  const problem = adapter.validateTarget(target);
  if (problem) throw unprocessable(problem);

  const run = deps.repos.syncRuns.insert({
    id: newId(),
    adapterId: adapter.id,
    sourceName: `${adapter.id}:${target.slice(0, 120)}`,
    startedAt: deps.now(),
    finishedAt: null,
    status: "RUNNING",
    fetched: 0,
    created: 0,
    duplicates: 0,
    errors: [],
  });
  recordAudit(deps.repos, deps.now, "sync_run", run.id, "sync.started", { adapterId: adapter.id }, actor);

  const items: SyncResult["items"] = [];
  let created = 0;
  let duplicates = 0;
  let warnings: string[] = [];
  try {
    const fetched = await adapter.fetch(target, { fetcher: deps.fetcher, now: deps.now });
    warnings = fetched.warnings;
    for (const item of fetched.items) {
      try {
        const r = createOpportunity(deps, item, `sync:${adapter.id}`);
        if (r.duplicate) duplicates++;
        else created++;
        items.push({ id: r.opportunity.id, duplicate: r.duplicate, title: r.opportunity.title });
      } catch (err) {
        warnings.push(`Skipped "${item.title}": ${(err as Error)?.message ?? "error"}`);
      }
    }
    const finished = deps.repos.syncRuns.update(run.id, {
      finishedAt: deps.now(),
      status: warnings.length ? "PARTIAL" : "SUCCESS",
      fetched: fetched.items.length,
      created,
      duplicates,
      errors: warnings,
    })!;
    recordAudit(deps.repos, deps.now, "sync_run", run.id, "sync.finished", { status: finished.status, fetched: fetched.items.length, created, duplicates }, actor);
    return { run: finished, created, duplicates, warnings, items };
  } catch (err) {
    const message = (err as Error)?.message ?? "Sync failed.";
    const finished = deps.repos.syncRuns.update(run.id, { finishedAt: deps.now(), status: "FAILED", errors: [...warnings, message], created, duplicates })!;
    recordAudit(deps.repos, deps.now, "sync_run", run.id, "sync.failed", { error: message }, actor);
    deps.logger.warn("source sync failed", { adapterId: adapter.id, error: message });
    return { run: finished, created, duplicates, warnings: [...warnings, message], items };
  }
}
