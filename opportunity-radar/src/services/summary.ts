/** Counts and short lists for the widget and page header. */
import type { AppDeps } from "../deps.ts";
import type { Opportunity } from "../types/entities.ts";
import { refreshFollowUpStatuses } from "./applications.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "ai" | "config">;

export type OpportunitySummary = Omit<Opportunity, "rawDescription" | "normalizedDescription"> & {
  applicationStatus: string | null;
  appliedAt: string | null;
};

export function toSummary(deps: Pick<AppDeps, "repos">, o: Opportunity): OpportunitySummary {
  const { rawDescription, normalizedDescription, ...rest } = o;
  const app = deps.repos.applications.findByOpportunity(o.id);
  return { ...rest, applicationStatus: app?.status ?? null, appliedAt: app?.appliedAt ?? null };
}

export async function buildSummary(deps: Deps) {
  refreshFollowUpStatuses(deps);
  const now = deps.now();
  const counts = deps.repos.opportunities.counts(now);
  const ai = await deps.ai.health();
  return {
    counts,
    recentVerified: deps.repos.opportunities.listRecentVerified(5).map((o) => toSummary(deps, o)),
    followUpsDue: deps.repos.opportunities.listFollowUpsDue(now).map((o) => toSummary(deps, o)),
    ai,
    generatedAt: now,
  };
}
