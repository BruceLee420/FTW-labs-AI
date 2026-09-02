/**
 * Environment configuration. Every value has a safe local default; the
 * summary returned by `safeConfigSummary` is what the UI sees and contains no
 * filesystem paths or secrets.
 */
import { resolve } from "node:path";
import { z } from "zod";

const Bool = z
  .string()
  .optional()
  .transform((v) => (v ?? "").trim().toLowerCase())
  .transform((v) => v === "1" || v === "true" || v === "yes");

const IntWithDefault = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const List = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  OPPORTUNITY_RADAR_HOST: z.string().trim().default("127.0.0.1"),
  OPPORTUNITY_RADAR_PORT: IntWithDefault(4747, 1, 65535),
  OPPORTUNITY_RADAR_AUTH_TOKEN: z.string().optional(),
  OPPORTUNITY_RADAR_ALLOWED_ORIGINS: List,
  OPPORTUNITY_RADAR_DB_PATH: z.string().trim().default("./data/opportunity-radar.sqlite"),
  OPPORTUNITY_RADAR_RESUMES_DIR: z.string().trim().default("./private/resumes/source"),
  OPPORTUNITY_RADAR_OUTPUT_DIR: z.string().trim().default("./private/output"),
  OPPORTUNITY_RADAR_AI_PROVIDER: z
    .string()
    .trim()
    .toLowerCase()
    .default("ollama")
    .pipe(z.enum(["ollama", "none"])),
  OLLAMA_BASE_URL: z.string().trim().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().trim().default("llama3.1"),
  OPPORTUNITY_RADAR_AI_TIMEOUT_SECONDS: IntWithDefault(90, 5, 900),
  OPPORTUNITY_RADAR_FOLLOW_UP_DAYS: IntWithDefault(7, 0, 365),
  OPPORTUNITY_RADAR_FETCH_MAX_BYTES: IntWithDefault(2_000_000, 10_000, 20_000_000),
  OPPORTUNITY_RADAR_FETCH_MAX_REDIRECTS: IntWithDefault(5, 0, 10),
  OPPORTUNITY_RADAR_FETCH_TIMEOUT_SECONDS: IntWithDefault(15, 1, 120),
  OPPORTUNITY_RADAR_URL_DENYLIST: List,
  OPPORTUNITY_RADAR_GREENHOUSE_BOARDS: List,
  OPPORTUNITY_RADAR_RSS_FEEDS: List,
  OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: Bool,
});

export interface RadarConfig {
  host: string;
  port: number;
  authToken: string | null;
  allowedOrigins: string[];
  dbPath: string;
  resumesDir: string;
  resumesDirConfigured: boolean;
  outputDir: string;
  aiProvider: "ollama" | "none";
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiTimeoutMs: number;
  followUpDays: number;
  fetchMaxBytes: number;
  fetchMaxRedirects: number;
  fetchTimeoutMs: number;
  urlDenylist: string[];
  greenhouseBoards: string[];
  rssFeeds: string[];
  rateLimitEnabled: boolean;
  /** Directory relative paths resolve against (the module root). */
  baseDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, baseDir: string = process.cwd()): RadarConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid Opportunity Radar configuration: ${issues}`);
  }
  const e = parsed.data;
  const port = e.OPPORTUNITY_RADAR_PORT;
  const defaultOrigins = ["https://ftwlabs.ai", `http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const authToken = e.OPPORTUNITY_RADAR_AUTH_TOKEN?.trim() || null;
  const host = e.OPPORTUNITY_RADAR_HOST;
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error(
      `OPPORTUNITY_RADAR_HOST=${host} is not loopback. Set OPPORTUNITY_RADAR_AUTH_TOKEN before exposing the service beyond this machine.`,
    );
  }
  const dbPath = e.OPPORTUNITY_RADAR_DB_PATH === ":memory:" ? ":memory:" : resolve(baseDir, e.OPPORTUNITY_RADAR_DB_PATH);
  return {
    host,
    port,
    authToken,
    allowedOrigins: e.OPPORTUNITY_RADAR_ALLOWED_ORIGINS.length ? e.OPPORTUNITY_RADAR_ALLOWED_ORIGINS : defaultOrigins,
    dbPath,
    resumesDir: resolve(baseDir, e.OPPORTUNITY_RADAR_RESUMES_DIR),
    resumesDirConfigured: Boolean(env.OPPORTUNITY_RADAR_RESUMES_DIR?.trim()),
    outputDir: resolve(baseDir, e.OPPORTUNITY_RADAR_OUTPUT_DIR),
    aiProvider: e.OPPORTUNITY_RADAR_AI_PROVIDER,
    ollamaBaseUrl: e.OLLAMA_BASE_URL.replace(/\/+$/, ""),
    ollamaModel: e.OLLAMA_MODEL,
    aiTimeoutMs: e.OPPORTUNITY_RADAR_AI_TIMEOUT_SECONDS * 1000,
    followUpDays: e.OPPORTUNITY_RADAR_FOLLOW_UP_DAYS,
    fetchMaxBytes: e.OPPORTUNITY_RADAR_FETCH_MAX_BYTES,
    fetchMaxRedirects: e.OPPORTUNITY_RADAR_FETCH_MAX_REDIRECTS,
    fetchTimeoutMs: e.OPPORTUNITY_RADAR_FETCH_TIMEOUT_SECONDS * 1000,
    urlDenylist: e.OPPORTUNITY_RADAR_URL_DENYLIST.map((h) => h.toLowerCase()),
    greenhouseBoards: e.OPPORTUNITY_RADAR_GREENHOUSE_BOARDS,
    rssFeeds: e.OPPORTUNITY_RADAR_RSS_FEEDS,
    rateLimitEnabled: !e.OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT,
    baseDir,
  };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** What the settings page may see. No paths, no secrets. */
export function safeConfigSummary(config: RadarConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    authRequired: Boolean(config.authToken),
    allowedOrigins: config.allowedOrigins,
    resumesDirConfigured: config.resumesDirConfigured,
    aiProvider: config.aiProvider,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ollamaModel: config.ollamaModel,
    aiTimeoutSeconds: config.aiTimeoutMs / 1000,
    followUpDays: config.followUpDays,
    fetchMaxBytes: config.fetchMaxBytes,
    fetchMaxRedirects: config.fetchMaxRedirects,
    fetchTimeoutSeconds: config.fetchTimeoutMs / 1000,
    urlDenylistCount: config.urlDenylist.length,
    greenhouseBoards: config.greenhouseBoards,
    rssFeeds: config.rssFeeds,
    rateLimitEnabled: config.rateLimitEnabled,
  };
}
