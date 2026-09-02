/**
 * Opportunity Radar — local service entry point.
 *
 *   npm run dev      (watch mode)
 *   npm start
 *
 * Binds to loopback by default. See ../docs/opportunity-radar-setup.md.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, safeConfigSummary } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { createSqliteRepositories } from "./repositories/sqlite/index.ts";
import { createAiProvider } from "./ai/index.ts";
import { createSafeFetcher } from "./security/ssrf.ts";
import { defaultAdapters } from "./adapters/registry.ts";
import { createLogger } from "./logger.ts";
import { createApp } from "./app.ts";
import { registerRoutes } from "./http/routes/index.ts";
import { nowIso } from "./utils/time.ts";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(process.env, moduleRoot);
const logger = createLogger();

// Create the default (git-ignored) résumé folder so the library has somewhere to point.
// A user-configured folder is never created implicitly.
if (!config.resumesDirConfigured && !existsSync(config.resumesDir)) mkdirSync(config.resumesDir, { recursive: true });

const db = openDatabase(config.dbPath);
const migration = migrate(db);
if (migration.applied.length) logger.info("migrations applied", { applied: migration.applied });

const deps = {
  config,
  repos: createSqliteRepositories(db),
  ai: createAiProvider(config),
  fetcher: createSafeFetcher(config),
  adapters: defaultAdapters(),
  logger,
  now: nowIso,
};

const app = createApp(deps, registerRoutes);
const server = createServer((req, res) => {
  app.handle(req, res).catch((err) => {
    logger.error("request handler crashed", { message: (err as Error)?.message });
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong on the server." }));
  });
});

server.listen(config.port, config.host, () => {
  logger.info("Opportunity Radar listening", {
    url: `http://${config.host}:${config.port}/opportunity-radar/`,
    ...safeConfigSummary(config),
  });
});

const shutdown = () => {
  logger.info("shutting down");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
