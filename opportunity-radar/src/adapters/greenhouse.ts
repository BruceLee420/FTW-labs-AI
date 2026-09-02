/**
 * Greenhouse Job Board API adapter. The API is public, documented and needs
 * no credentials; it exists so third parties can display a company's open
 * roles. https://developers.greenhouse.io/job-board.html
 */
import { z } from "zod";
import type { AdapterContext, AdapterFetchResult, AtsAdapter } from "./types.ts";
import type { ManualOpportunityInput } from "../schemas/opportunity.ts";
import { ManualOpportunityInputSchema } from "../schemas/opportunity.ts";
import { decodeEntities, htmlToText } from "../utils/html.ts";

const BoardSchema = z.object({ name: z.string().optional() }).passthrough();
const JobSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    absolute_url: z.string(),
    updated_at: z.string().optional(),
    location: z.object({ name: z.string().optional() }).optional(),
    content: z.string().optional(),
  })
  .passthrough();
const JobsSchema = z.object({ jobs: z.array(z.unknown()) });

export class GreenhouseAdapter implements AtsAdapter {
  readonly id = "greenhouse";
  readonly displayName = "Greenhouse job board";
  readonly policyNote = "Uses Greenhouse's public Job Board API — a documented, credential-free feed that employers publish so third parties can display their open roles.";
  readonly targetHint = "board token (the slug in boards.greenhouse.io/<token>)";
  private readonly apiBase: string;

  constructor(apiBase = "https://boards-api.greenhouse.io/v1/boards") {
    this.apiBase = apiBase.replace(/\/+$/, "");
  }

  validateTarget(target: string): string | null {
    return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(target) ? null : "A Greenhouse board token contains only letters, digits, hyphens and underscores.";
  }

  async fetch(target: string, ctx: AdapterContext): Promise<AdapterFetchResult> {
    const token = target.trim().toLowerCase();
    const warnings: string[] = [];
    const boardRes = await ctx.fetcher(`${this.apiBase}/${token}`, { skipRobots: true, acceptContentTypes: ["application/json"] });
    if (!boardRes.ok) throw new Error(`Greenhouse board ${token} returned ${boardRes.status}`);
    const board = BoardSchema.safeParse(safeJson(boardRes.body));
    const companyName = (board.success && board.data.name?.trim()) || token;

    const jobsRes = await ctx.fetcher(`${this.apiBase}/${token}/jobs?content=true`, { skipRobots: true, acceptContentTypes: ["application/json"] });
    if (!jobsRes.ok) throw new Error(`Greenhouse board ${token} returned ${jobsRes.status}`);
    const jobs = JobsSchema.safeParse(safeJson(jobsRes.body));
    if (!jobs.success) throw new Error(`Greenhouse board ${token} returned an unexpected payload`);

    const items: ManualOpportunityInput[] = [];
    for (const raw of jobs.data.jobs) {
      const job = JobSchema.safeParse(raw);
      if (!job.success) {
        warnings.push("Skipped a job with an unexpected shape.");
        continue;
      }
      const j = job.data;
      const parsed = ManualOpportunityInputSchema.safeParse({
        companyName,
        title: j.title,
        sourceName: `greenhouse:${token}`,
        sourceType: "OFFICIAL_ATS",
        sourceUrl: j.absolute_url,
        applicationUrl: j.absolute_url,
        canonicalUrl: j.absolute_url,
        externalId: String(j.id),
        rawDescription: j.content ? htmlToText(decodeEntities(j.content)) : "",
        locationText: j.location?.name ?? null,
        postedAt: j.updated_at ?? null,
        officialCareerUrl: `https://boards.greenhouse.io/${token}`,
      });
      if (!parsed.success) {
        warnings.push(`Skipped "${j.title}": ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        continue;
      }
      items.push(parsed.data);
    }
    return { sourceName: `greenhouse:${token}`, items, warnings };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
