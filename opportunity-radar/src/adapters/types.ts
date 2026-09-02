/**
 * Source adapter interface. An adapter turns a permitted external source
 * (an official ATS board API, an RSS feed, a fixture) into ManualOpportunityInput
 * items that flow through the same normalise → dedupe → evaluate path as a
 * manual entry. Adapters never submit anything anywhere.
 */
import type { ManualOpportunityInput } from "../schemas/opportunity.ts";
import type { SafeFetcher } from "../security/fetchTypes.ts";

export interface AdapterContext {
  fetcher: SafeFetcher;
  now: () => string;
}

export interface AdapterFetchResult {
  sourceName: string;
  items: ManualOpportunityInput[];
  /** Non-fatal problems (a malformed entry, a skipped item). */
  warnings: string[];
}

export interface AtsAdapter {
  /** Stable id used in API calls and sync-run records, e.g. "greenhouse". */
  readonly id: string;
  readonly displayName: string;
  /** Why this source is permitted — shown in the UI and docs. */
  readonly policyNote: string;
  /** Human hint for the `target` argument, e.g. "board token". */
  readonly targetHint: string;
  /** Validate the target before any network call. Return an error message or null. */
  validateTarget(target: string): string | null;
  fetch(target: string, ctx: AdapterContext): Promise<AdapterFetchResult>;
}
