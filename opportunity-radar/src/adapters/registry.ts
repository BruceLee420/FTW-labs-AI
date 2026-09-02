import type { AtsAdapter } from "./types.ts";
import { GreenhouseAdapter } from "./greenhouse.ts";
import { RssAdapter } from "./rss.ts";
import { MockAdapter } from "./mock.ts";

export function defaultAdapters(): AtsAdapter[] {
  return [new GreenhouseAdapter(), new RssAdapter(), new MockAdapter()];
}

export function findAdapter(adapters: AtsAdapter[], id: string): AtsAdapter | null {
  return adapters.find((a) => a.id === id) ?? null;
}
