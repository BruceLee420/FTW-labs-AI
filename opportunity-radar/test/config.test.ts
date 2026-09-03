/**
 * Configuration loading: safe defaults, path resolution against baseDir,
 * the non-loopback-requires-token rule, validation errors, and the
 * path/secret-free summary shown to the UI. Nothing touches the filesystem.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { isLoopbackHost, loadConfig, safeConfigSummary } from "../src/config.ts";

const BASE = "/tmp/x";

describe("loadConfig defaults", () => {
  test("safe local defaults", () => {
    const c = loadConfig({}, BASE);
    assert.equal(c.port, 4747);
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.authToken, null);
    assert.equal(c.aiProvider, "ollama");
    assert.equal(c.ollamaModel, "llama3.1");
    assert.equal(c.ollamaBaseUrl, "http://localhost:11434");
    assert.equal(c.followUpDays, 7);
    assert.equal(c.aiTimeoutMs, 90_000);
    assert.equal(c.fetchTimeoutMs, 15_000);
    assert.equal(c.fetchMaxBytes, 2_000_000);
    assert.equal(c.fetchMaxRedirects, 5);
    assert.deepEqual(c.urlDenylist, []);
    assert.deepEqual(c.greenhouseBoards, []);
    assert.deepEqual(c.rssFeeds, []);
    assert.equal(c.rateLimitEnabled, true);
    assert.equal(c.baseDir, BASE);
  });

  test("relative paths resolve under baseDir; resumesDirConfigured false unless set", () => {
    const c = loadConfig({}, BASE);
    assert.equal(c.dbPath, resolve(BASE, "data/opportunity-radar.sqlite"));
    assert.equal(c.resumesDir, resolve(BASE, "private/resumes/source"));
    assert.equal(c.outputDir, resolve(BASE, "private/output"));
    assert.equal(c.resumesDirConfigured, false);

    const custom = loadConfig({ OPPORTUNITY_RADAR_RESUMES_DIR: "my/resumes", OPPORTUNITY_RADAR_OUTPUT_DIR: "/srv/out", OPPORTUNITY_RADAR_DB_PATH: ":memory:" }, BASE);
    assert.equal(custom.resumesDir, resolve(BASE, "my/resumes"));
    assert.equal(custom.resumesDirConfigured, true);
    assert.equal(custom.outputDir, "/srv/out");
    assert.equal(custom.dbPath, ":memory:");

    assert.equal(loadConfig({ OPPORTUNITY_RADAR_RESUMES_DIR: "   " }, BASE).resumesDirConfigured, false);
  });

  test("allowed origins default from the port and are replaced when configured", () => {
    assert.deepEqual(loadConfig({}, BASE).allowedOrigins, ["https://ftwlabs.ai", "http://127.0.0.1:4747", "http://localhost:4747"]);
    assert.deepEqual(loadConfig({ OPPORTUNITY_RADAR_PORT: "5050" }, BASE).allowedOrigins, ["https://ftwlabs.ai", "http://127.0.0.1:5050", "http://localhost:5050"]);
    assert.deepEqual(loadConfig({ OPPORTUNITY_RADAR_ALLOWED_ORIGINS: "https://a.example, https://b.example" }, BASE).allowedOrigins, ["https://a.example", "https://b.example"]);
  });
});

describe("loadConfig validation", () => {
  test("a non-loopback host requires an auth token", () => {
    assert.throws(() => loadConfig({ OPPORTUNITY_RADAR_HOST: "0.0.0.0" }, BASE), /not loopback/);
    assert.throws(() => loadConfig({ OPPORTUNITY_RADAR_HOST: "0.0.0.0", OPPORTUNITY_RADAR_AUTH_TOKEN: "   " }, BASE), /not loopback/);
    const c = loadConfig({ OPPORTUNITY_RADAR_HOST: "0.0.0.0", OPPORTUNITY_RADAR_AUTH_TOKEN: "  s3cret  " }, BASE);
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.authToken, "s3cret");
    assert.equal(loadConfig({ OPPORTUNITY_RADAR_HOST: "localhost" }, BASE).host, "localhost");
  });

  test("invalid ports throw", () => {
    for (const port of ["abc", "70000", "0", "-1", "12.5"]) {
      assert.throws(() => loadConfig({ OPPORTUNITY_RADAR_PORT: port }, BASE), /Invalid Opportunity Radar configuration.*OPPORTUNITY_RADAR_PORT/, port);
    }
    assert.equal(loadConfig({ OPPORTUNITY_RADAR_PORT: " 8080 " }, BASE).port, 8080);
    assert.equal(loadConfig({ OPPORTUNITY_RADAR_PORT: "" }, BASE).port, 4747);
  });

  test("AI provider is case-insensitive and restricted", () => {
    assert.equal(loadConfig({ OPPORTUNITY_RADAR_AI_PROVIDER: "NONE" }, BASE).aiProvider, "none");
    assert.equal(loadConfig({ OPPORTUNITY_RADAR_AI_PROVIDER: " Ollama " }, BASE).aiProvider, "ollama");
    assert.throws(() => loadConfig({ OPPORTUNITY_RADAR_AI_PROVIDER: "gpt" }, BASE), /OPPORTUNITY_RADAR_AI_PROVIDER/);
  });

  test("lists are parsed from comma strings; denylist is lowercased", () => {
    const c = loadConfig(
      {
        OPPORTUNITY_RADAR_URL_DENYLIST: "Example.com, foo.org ,,",
        OPPORTUNITY_RADAR_GREENHOUSE_BOARDS: "acme, northwind",
        OPPORTUNITY_RADAR_RSS_FEEDS: "https://a.example/feed.xml",
      },
      BASE,
    );
    assert.deepEqual(c.urlDenylist, ["example.com", "foo.org"]);
    assert.deepEqual(c.greenhouseBoards, ["acme", "northwind"]);
    assert.deepEqual(c.rssFeeds, ["https://a.example/feed.xml"]);
  });

  test("numeric envs, booleans and Ollama URL trimming", () => {
    const c = loadConfig(
      {
        OPPORTUNITY_RADAR_AI_TIMEOUT_SECONDS: "30",
        OPPORTUNITY_RADAR_FOLLOW_UP_DAYS: "0",
        OPPORTUNITY_RADAR_FETCH_TIMEOUT_SECONDS: "2",
        OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: "true",
        OLLAMA_BASE_URL: "http://ollama.test:11434///",
      },
      BASE,
    );
    assert.equal(c.aiTimeoutMs, 30_000);
    assert.equal(c.followUpDays, 0);
    assert.equal(c.fetchTimeoutMs, 2_000);
    assert.equal(c.rateLimitEnabled, false);
    assert.equal(c.ollamaBaseUrl, "http://ollama.test:11434");
    for (const v of ["1", "yes", "TRUE"]) assert.equal(loadConfig({ OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: v }, BASE).rateLimitEnabled, false, v);
    for (const v of ["false", "0", "", "no"]) assert.equal(loadConfig({ OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: v }, BASE).rateLimitEnabled, true, v);
    assert.throws(() => loadConfig({ OPPORTUNITY_RADAR_AI_TIMEOUT_SECONDS: "1" }, BASE), /AI_TIMEOUT/);
    assert.throws(() => loadConfig({ OPPORTUNITY_RADAR_FETCH_MAX_REDIRECTS: "11" }, BASE), /FETCH_MAX_REDIRECTS/);
  });
});

describe("safeConfigSummary", () => {
  test("contains no filesystem paths and no secrets", () => {
    const c = loadConfig({ OPPORTUNITY_RADAR_AUTH_TOKEN: "s3cret-token", OPPORTUNITY_RADAR_URL_DENYLIST: "a.example", OPPORTUNITY_RADAR_RESUMES_DIR: "/tmp/x/private/resumes" }, BASE);
    const summary = safeConfigSummary(c);
    const text = JSON.stringify(summary);
    assert.ok(!text.includes("/tmp"), "summary must not leak paths");
    assert.ok(!text.includes("s3cret"), "summary must not leak the token");
    assert.equal(summary.authRequired, true);
    assert.equal(summary.resumesDirConfigured, true);
    assert.equal(summary.urlDenylistCount, 1);
    assert.equal(summary.aiTimeoutSeconds, 90);
    assert.equal(summary.fetchTimeoutSeconds, 15);
    assert.equal(summary.port, 4747);
    for (const key of ["dbPath", "resumesDir", "outputDir", "authToken", "baseDir", "urlDenylist"]) assert.equal(key in summary, false, `${key} must not be exposed`);
    assert.equal(safeConfigSummary(loadConfig({}, BASE)).authRequired, false);
  });
});

describe("isLoopbackHost", () => {
  test("cases", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.5.6.7", " LOCALHOST ", "127.0.0.1 "]) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["0.0.0.0", "example.com", "10.0.0.1", "127.0.0.1.evil.com", "localhost.evil.com", "::ffff:127.0.0.1", ""]) assert.equal(isLoopbackHost(h), false, h);
  });
});
