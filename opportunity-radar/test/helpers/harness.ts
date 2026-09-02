/**
 * Test harness: in-memory SQLite, fake AI provider, fake fetcher, and a real
 * HTTP server on an ephemeral loopback port driven through the app pipeline.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDeps } from "../../src/deps.ts";
import type { AiHealth, AiProvider, GenerateOptions, GenerateResult } from "../../src/ai/provider.ts";
import { AiUnavailableError } from "../../src/ai/provider.ts";
import type { SafeFetcher, SafeFetchResult } from "../../src/security/fetchTypes.ts";
import type { AtsAdapter } from "../../src/adapters/types.ts";
import { loadConfig, type RadarConfig } from "../../src/config.ts";
import { createApp, type App } from "../../src/app.ts";
import { registerRoutes } from "../../src/http/routes/index.ts";
import { silentLogger } from "../../src/logger.ts";
import { createTestRepos } from "./db.ts";

export class FakeAiProvider implements AiProvider {
  readonly id = "ollama" as const;
  readonly model: string;
  reachable = true;
  /** Queue of responses: strings (raw text) or objects (JSON-stringified). */
  responses: (string | object | Error)[] = [];
  calls: { prompt: string; options: GenerateOptions | undefined }[] = [];
  constructor(model = "fake-model") {
    this.model = model;
  }
  async health(): Promise<AiHealth> {
    return {
      provider: "ollama",
      model: this.model,
      reachable: this.reachable,
      modelAvailable: this.reachable,
      availableModels: this.reachable ? [this.model] : [],
      message: this.reachable ? "fake reachable" : "fake offline",
      checkedAt: new Date().toISOString(),
    };
  }
  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    this.calls.push({ prompt, options });
    if (!this.reachable) throw new AiUnavailableError("fake provider offline");
    const next = this.responses.shift();
    if (next === undefined) throw new AiUnavailableError("fake provider has no queued response");
    if (next instanceof Error) throw next;
    return { text: typeof next === "string" ? next : JSON.stringify(next), model: this.model, provider: "ollama", durationMs: 1 };
  }
}

export interface FakeRoute {
  status?: number;
  body?: string;
  contentType?: string;
  finalUrl?: string;
  headers?: Record<string, string>;
}

export function fakeFetcher(routes: Record<string, FakeRoute>): SafeFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string): Promise<SafeFetchResult> => {
    calls.push(url);
    const route = routes[url];
    if (!route) return { ok: false, status: 404, finalUrl: url, contentType: "text/plain", body: "not found", truncated: false, redirects: [], headers: {} };
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      finalUrl: route.finalUrl ?? url,
      contentType: route.contentType ?? "text/html",
      body: route.body ?? "",
      truncated: false,
      redirects: [],
      headers: route.headers ?? {},
    };
  }) as SafeFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export interface HarnessOptions {
  ai?: AiProvider;
  fetcher?: SafeFetcher;
  adapters?: AtsAdapter[];
  env?: Record<string, string>;
  config?: Partial<RadarConfig>;
  now?: () => string;
}

export interface Harness {
  deps: AppDeps;
  app: App;
  base: string;
  ai: FakeAiProvider;
  api<T = any>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean }): Promise<{ status: number; data: T; headers: Headers; text: string }>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "radar-test-"));
  const config: RadarConfig = {
    ...loadConfig(
      {
        OPPORTUNITY_RADAR_DB_PATH: ":memory:",
        OPPORTUNITY_RADAR_RESUMES_DIR: join(tmp, "resumes"),
        OPPORTUNITY_RADAR_OUTPUT_DIR: join(tmp, "output"),
        OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: "true",
        OPPORTUNITY_RADAR_AI_PROVIDER: "ollama",
        ...(options.env ?? {}),
      },
      join(tmp, "..", "..", "..", "..", "home", "user", "FTW-labs-AI", "opportunity-radar"),
    ),
    ...(options.config ?? {}),
  };
  // baseDir must point at the real module so public/ pages resolve.
  config.baseDir = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  const ai = (options.ai as FakeAiProvider) ?? new FakeAiProvider();
  const deps: AppDeps = {
    config,
    repos: createTestRepos(),
    ai,
    fetcher: options.fetcher ?? fakeFetcher({}),
    adapters: options.adapters ?? [],
    logger: silentLogger,
    now: options.now ?? (() => new Date().toISOString()),
  };
  const app = createApp(deps, registerRoutes);
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  // Config port must match for the Host check.
  config.port = port;
  config.allowedOrigins = [`http://127.0.0.1:${port}`, "https://ftwlabs.ai"];

  return {
    deps,
    app,
    base,
    ai,
    async api(path, init = {}) {
      const res = await fetch(base + (path.startsWith("/") ? path : `/api/opportunity-radar/${path}`), {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers: {
          "X-Radar-Request": "1",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { status: res.status, data, headers: res.headers, text };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const SAMPLE_LISTING = {
  companyName: "Northwind Analytics",
  title: "Senior Software Engineer (Remote)",
  sourceName: "greenhouse:northwind",
  sourceType: "OFFICIAL_ATS" as const,
  sourceUrl: "https://boards.greenhouse.io/northwind/jobs/12345",
  applicationUrl: "https://boards.greenhouse.io/northwind/jobs/12345",
  companyWebsite: "https://northwind.example",
  officialCareerUrl: "https://northwind.example/careers",
  locationText: "Remote - United States",
  rawDescription: [
    "About the role",
    "Northwind Analytics builds data tooling for logistics teams. You will join a distributed engineering team and own services end to end.",
    "This is a fully remote role open to candidates located in the United States.",
    "Responsibilities",
    "- Design and ship TypeScript services on Node.js with PostgreSQL",
    "- Review code and mentor engineers across the team",
    "- Partner with product to plan quarterly roadmaps",
    "- Improve observability and reliability of production systems",
    "Requirements",
    "- 5+ years building production web services",
    "- Strong TypeScript and Node.js experience",
    "- Experience with PostgreSQL and SQL performance tuning",
    "- Experience with AWS and Docker",
    "Nice to have",
    "- Kubernetes experience",
    "- Familiarity with React",
    "Compensation: $150,000 - $185,000 per year plus equity.",
    "Our interview process has three stages: a recruiter screen, a technical interview, and a team conversation. Northwind Analytics is an equal opportunity employer.",
    "Contact: recruiting@northwind.example",
  ].join("\n"),
};

export const SCAM_LISTING = {
  companyName: "Global Payments Solutions",
  title: "Data Entry Clerk - Work From Home - Immediate Start",
  sourceName: "manual",
  sourceType: "MANUAL_URL" as const,
  sourceUrl: "https://bit.ly/3abcdef",
  rawDescription: [
    "Urgent hiring! Start today, no interview needed. Earn $500 per day from home.",
    "To get started you must purchase a starter equipment kit with gift cards and send the codes to our HR on Telegram @gps_hr.",
    "Send your SSN and bank account details to gpshiring@gmail.com to process your first payment.",
  ].join("\n"),
};
