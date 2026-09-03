/**
 * HTTP plumbing: router matching, query parsing, auth guards, the rate
 * limiter, and an end-to-end run of the app pipeline (CORS → Host → auth →
 * rate limit → CSRF marker → route → error mapping) over a real loopback
 * server with stub deps. Requests go through node:http so the Host header
 * and HEAD/large bodies are fully under test control.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Router } from "../src/http/router.ts";
import { queryToObject } from "../src/http/query.ts";
import { json } from "../src/http/respond.ts";
import { createAuthGuard, isAllowedHost, isLoopbackAddress, LoopbackGuard, TokenGuard } from "../src/security/auth.ts";
import { createRateLimiter, unlimited } from "../src/security/rateLimit.ts";
import { loadConfig, type RadarConfig } from "../src/config.ts";
import { createApp, type AppOptions } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { HttpError } from "../src/utils/errors.ts";
import { UnsafeUrlError } from "../src/security/fetchTypes.ts";
import { silentLogger } from "../src/logger.ts";
import { FakeAiProvider, fakeFetcher } from "./helpers/harness.ts";

const API = "/api/opportunity-radar";

// ----------------------------------------------------------------- router

describe("Router", () => {
  const router = new Router();
  router.get(`${API}/items/:id`, () => json({}));
  router.post(`${API}/items/:id`, () => json({}));
  router.add("delete", `${API}/items/:id/notes/:noteId`, () => json({}));
  router.get(`${API}/health`, () => json({}), { public: true });

  test("matches and decodes params (including %20)", () => {
    const m = router.match("GET", `${API}/items/hello%20world`);
    assert.ok(m && m !== "method");
    assert.deepEqual(m.params, { id: "hello world" });
    assert.deepEqual(m.options, {});
    const nested = router.match("DELETE", `${API}/items/a-1/notes/n%2F2`);
    assert.ok(nested && nested !== "method");
    assert.deepEqual(nested.params, { id: "a-1", noteId: "n/2" });
  });

  test("returns 'method' for a known path with the wrong verb and null for unknown paths", () => {
    assert.equal(router.match("PATCH", `${API}/items/1`), "method");
    assert.equal(router.match("GET", `${API}/nope`), null);
    assert.equal(router.match("GET", `${API}/items`), null);
    assert.equal(router.match("GET", `${API}/items/1/extra`), null);
  });

  test("method matching is case-insensitive; trailing slashes are tolerated; options are carried", () => {
    const m = router.match("get", `${API}/items/1/`);
    assert.ok(m && m !== "method");
    const health = router.match("GET", `${API}/health`);
    assert.ok(health && health !== "method");
    assert.equal(health.options.public, true);
  });

  test("malformed percent-encoding does not match", () => {
    assert.equal(router.match("GET", `${API}/items/%E0%A4%A`), null);
  });

  test("allowedMethods lists every verb registered for a path", () => {
    assert.deepEqual(router.allowedMethods(`${API}/items/1`).sort(), ["GET", "POST"]);
    assert.deepEqual(router.allowedMethods(`${API}/nope`), []);
  });
});

// ------------------------------------------------------------------ query

describe("queryToObject", () => {
  test("repeated keys and comma lists become arrays for list keys; scalars keep the last value", () => {
    const q = queryToObject(new URL("http://x/?status=NEW,REVIEWED&status=APPLIED&workMode=REMOTE&q=a&q=b&empty=&blank=%20"));
    assert.deepEqual(q, { status: ["NEW", "REVIEWED", "APPLIED"], workMode: ["REMOTE"], q: "b" });
  });

  test("non-list keys are not split on commas", () => {
    assert.deepEqual(queryToObject(new URL("http://x/?q=a,b")), { q: "a,b" });
    assert.deepEqual(queryToObject(new URL("http://x/")), {});
  });
});

// ------------------------------------------------------------------- auth

describe("auth", () => {
  const config = loadConfig({}, tmpdir());

  test("isLoopbackAddress", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "127.10.20.30"]) assert.equal(isLoopbackAddress(a), true, a);
    for (const a of ["10.0.0.1", "::ffff:10.0.0.1", "0.0.0.0", "", "localhost"]) assert.equal(isLoopbackAddress(a), false, a);
  });

  test("isAllowedHost accepts loopback names on the configured port and allowlisted origin hosts", () => {
    for (const h of ["127.0.0.1:4747", "localhost:4747", "[::1]:4747", "localhost", "LOCALHOST:4747", "ftwlabs.ai"]) assert.equal(isAllowedHost(h, config), true, h);
    for (const h of ["127.0.0.1:9999", "evil.com", "evil.com:4747", "ftwlabs.ai:8443", "", "127.0.0.1:4747:1"]) assert.equal(isAllowedHost(h, config), false, h);
    assert.equal(isAllowedHost(undefined, config), false);
    const exposed = loadConfig({ OPPORTUNITY_RADAR_HOST: "0.0.0.0", OPPORTUNITY_RADAR_AUTH_TOKEN: "t0ken" }, tmpdir());
    assert.equal(isAllowedHost("0.0.0.0:4747", exposed), true);
    const custom = loadConfig({ OPPORTUNITY_RADAR_ALLOWED_ORIGINS: "https://radar.example:8443" }, tmpdir());
    assert.equal(isAllowedHost("radar.example:8443", custom), true);
    assert.equal(isAllowedHost("radar.example", custom), false);
  });

  test("TokenGuard accepts a bearer token or X-Radar-Token and rejects everything else", () => {
    const guard = new TokenGuard("s3cret");
    const auth = (headers: IncomingHttpHeaders) => guard.authenticate({ headers, remoteAddress: "10.0.0.1" });
    assert.deepEqual(auth({ authorization: "Bearer s3cret" }), { actor: "token-user" });
    assert.deepEqual(auth({ authorization: "bearer   s3cret " }), { actor: "token-user" });
    assert.deepEqual(auth({ "x-radar-token": "s3cret" }), { actor: "token-user" });
    assert.equal(auth({ authorization: "Bearer nope00" }), null, "same length, wrong value");
    assert.equal(auth({ authorization: "Bearer s3cret1" }), null, "length mismatch");
    assert.equal(auth({ authorization: "Bearer " }), null);
    assert.equal(auth({ authorization: "Basic s3cret" }), null);
    assert.equal(auth({ "x-radar-token": "" }), null);
    assert.equal(auth({}), null);
    assert.equal(guard.id, "token");
  });

  test("LoopbackGuard requires a loopback remote and an allowed Host", () => {
    const guard = new LoopbackGuard(config);
    assert.deepEqual(guard.authenticate({ headers: { host: "127.0.0.1:4747" }, remoteAddress: "127.0.0.1" }), { actor: "local-user" });
    assert.deepEqual(guard.authenticate({ headers: { host: "localhost:4747" }, remoteAddress: "::ffff:127.0.0.1" }), { actor: "local-user" });
    assert.equal(guard.authenticate({ headers: { host: "127.0.0.1:4747" }, remoteAddress: "10.0.0.1" }), null);
    assert.equal(guard.authenticate({ headers: { host: "evil.com" }, remoteAddress: "127.0.0.1" }), null);
    assert.equal(guard.authenticate({ headers: {}, remoteAddress: "127.0.0.1" }), null);
    assert.equal(guard.id, "loopback");
  });

  test("createAuthGuard picks the token guard only when a token is configured", () => {
    assert.equal(createAuthGuard(config).id, "loopback");
    assert.equal(createAuthGuard(loadConfig({ OPPORTUNITY_RADAR_AUTH_TOKEN: "t0ken" }, tmpdir())).id, "token");
  });
});

// -------------------------------------------------------------- rateLimit

describe("createRateLimiter", () => {
  test("spends capacity then refills with the injected clock", () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerMinute: 60_000 }); // 1 token per ms
    assert.equal(limiter.take("k", 0), true);
    assert.equal(limiter.take("k", 0), true);
    assert.equal(limiter.take("k", 0), false);
    assert.equal(limiter.take("k", 1), true, "one token refilled after 1 ms");
    assert.equal(limiter.take("k", 1), false);
    assert.equal(limiter.take("other", 1), true, "buckets are per key");
    assert.equal(limiter.take("k", 100), true, "refill is capped at capacity");
    assert.equal(limiter.take("k", 100), true);
    assert.equal(limiter.take("k", 100), false);
  });

  test("zero refill never recovers until reset; unlimited always allows", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerMinute: 0 });
    assert.equal(limiter.take("k", 0), true);
    assert.equal(limiter.take("k", 10_000_000), false);
    limiter.reset();
    assert.equal(limiter.take("k", 10_000_000), true);
    assert.equal(unlimited.take("anyone"), true);
  });
});

// ---------------------------------------------------------- app pipeline

interface Raw {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown> | null;
}

interface Started {
  port: number;
  config: RadarConfig;
  call(opts: { method?: string; path: string; headers?: Record<string, string | number>; body?: string | Buffer }): Promise<Raw>;
  close(): Promise<void>;
}

const FailingSchema = z.object({ n: z.number() });

function registerTestRoutes(router: Router): void {
  router.get(`${API}/ping`, () => json({ pong: true }));
  router.add("HEAD", `${API}/ping`, () => json({ pong: true }));
  router.post(`${API}/echo`, async (ctx) => json({ received: await ctx.readJson() }));
  router.get(`${API}/public`, () => json({ public: true }), { public: true });
  router.get(`${API}/expensive`, () => json({ ok: true }), { expensive: true });
  router.get(`${API}/conflict`, () => {
    throw new HttpError(409, "nope");
  });
  router.get(`${API}/zod`, () => {
    FailingSchema.parse({ n: "x" });
    return json({});
  });
  router.get(`${API}/boom`, () => {
    throw new Error("secret detail");
  });
  router.get(`${API}/unsafe`, () => {
    throw new UnsafeUrlError("bad url");
  });
  router.get(`${API}/items/:id`, (ctx) => json({ id: ctx.params.id, actor: ctx.actor }));
}

async function startApp(options: AppOptions = {}): Promise<Started> {
  const config = loadConfig({ OPPORTUNITY_RADAR_DISABLE_RATE_LIMIT: "true", OPPORTUNITY_RADAR_DB_PATH: ":memory:" }, tmpdir());
  const deps: AppDeps = {
    config,
    repos: {} as never,
    ai: new FakeAiProvider(),
    fetcher: fakeFetcher({}),
    adapters: [],
    logger: silentLogger,
    now: () => "2026-09-02T00:00:00.000Z",
  };
  const app = createApp(deps, registerTestRoutes, options);
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  config.port = port;
  config.allowedOrigins = [`http://127.0.0.1:${port}`, "https://ftwlabs.ai"];
  return {
    port,
    config,
    call: (opts) =>
      new Promise<Raw>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers ?? {} }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> | null = null;
            try {
              parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
            } catch {
              parsed = null;
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: parsed });
          });
        });
        req.on("error", reject);
        req.end(opts.body);
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const MARKER = { "X-Radar-Request": "1" };
const JSON_POST = { ...MARKER, "Content-Type": "application/json" };

describe("app pipeline", () => {
  let loopback: Started;
  let token: Started;
  let limited: Started;

  before(async () => {
    loopback = await startApp();
    token = await startApp({ authGuard: new TokenGuard("secret") });
    limited = await startApp({ expensiveLimiter: createRateLimiter({ capacity: 1, refillPerMinute: 0 }) });
  });
  after(async () => {
    await Promise.all([loopback.close(), token.close(), limited.close()]);
  });

  test("404 JSON for an unknown path, 405 for a known path with the wrong method", async () => {
    const missing = await loopback.call({ path: `${API}/nope` });
    assert.equal(missing.status, 404);
    assert.match(missing.headers["content-type"] ?? "", /application\/json/);
    assert.equal(missing.json?.code, "not_found");
    const wrong = await loopback.call({ method: "DELETE", path: `${API}/ping`, headers: MARKER });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.json?.code, "method_not_allowed");
  });

  test("421 for a Host header that does not name this service", async () => {
    const evil = await loopback.call({ path: `${API}/ping`, headers: { Host: "evil.com" } });
    assert.equal(evil.status, 421);
    assert.equal(evil.json?.code, "bad_host");
    const wrongPort = await loopback.call({ path: `${API}/ping`, headers: { Host: "127.0.0.1:9" } });
    assert.equal(wrongPort.status, 421);
    const ok = await loopback.call({ path: `${API}/ping`, headers: { Host: `localhost:${loopback.port}` } });
    assert.equal(ok.status, 200);
  });

  test("TokenGuard: 401 without a token, 200 with the bearer token or X-Radar-Token, public routes open", async () => {
    assert.equal((await token.call({ path: `${API}/ping` })).status, 401);
    assert.equal((await token.call({ path: `${API}/ping`, headers: { Authorization: "Bearer wrong!" } })).status, 401);
    const ok = await token.call({ path: `${API}/items/hello%20world`, headers: { Authorization: "Bearer secret" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { id: "hello world", actor: "token-user" });
    assert.equal((await token.call({ path: `${API}/ping`, headers: { "X-Radar-Token": "secret" } })).status, 200);
    assert.equal((await token.call({ path: `${API}/public` })).status, 200);
    // A bearer token satisfies the CSRF check on its own (no marker header needed).
    const post = await token.call({ method: "POST", path: `${API}/echo`, headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, body: '{"a":1}' });
    assert.equal(post.status, 200);
    assert.deepEqual(post.json, { received: { a: 1 } });
  });

  test("LoopbackGuard: mutating requests need the X-Radar-Request marker", async () => {
    const noMarker = await loopback.call({ method: "POST", path: `${API}/echo`, headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noMarker.status, 403);
    assert.equal(noMarker.json?.code, "csrf");
    const withMarker = await loopback.call({ method: "POST", path: `${API}/echo`, headers: JSON_POST, body: '{"x":[1,2]}' });
    assert.equal(withMarker.status, 200);
    assert.deepEqual(withMarker.json, { received: { x: [1, 2] } });
    const get = await loopback.call({ path: `${API}/items/a-1` });
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, { id: "a-1", actor: "local-user" });
  });

  test("body handling: 415 for text/plain, 400 for malformed JSON, {} for an empty body, 413 when too large", async () => {
    const plain = await loopback.call({ method: "POST", path: `${API}/echo`, headers: { ...MARKER, "Content-Type": "text/plain" }, body: "hello" });
    assert.equal(plain.status, 415);
    assert.equal(plain.json?.code, "unsupported_media_type");

    const malformed = await loopback.call({ method: "POST", path: `${API}/echo`, headers: JSON_POST, body: "{bad" });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json?.code, "bad_json");

    const empty = await loopback.call({ method: "POST", path: `${API}/echo`, headers: JSON_POST });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { received: {} });

    const big = Buffer.alloc(Math.floor(6.5 * 1024 * 1024), "a");
    const tooLarge = await loopback.call({ method: "POST", path: `${API}/echo`, headers: { ...JSON_POST, "Content-Length": big.length }, body: big });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.json?.code, "too_large");
  });

  test("CORS headers only for an allowed Origin; OPTIONS preflight is 204", async () => {
    const allowedOrigin = `http://127.0.0.1:${loopback.port}`;
    const allowed = await loopback.call({ path: `${API}/ping`, headers: { Origin: allowedOrigin } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], allowedOrigin);
    assert.equal(allowed.headers.vary, "Origin");
    assert.match(allowed.headers["access-control-allow-headers"] ?? "", /X-Radar-Request/);

    const denied = await loopback.call({ path: `${API}/ping`, headers: { Origin: "https://evil.example" } });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);

    const preflight = await loopback.call({ method: "OPTIONS", path: `${API}/echo`, headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.text, "");
    assert.equal(preflight.headers["access-control-allow-origin"], allowedOrigin);
    assert.match(preflight.headers["access-control-allow-methods"] ?? "", /POST/);
  });

  test("429 once the expensive bucket is exhausted; general routes unaffected", async () => {
    assert.equal((await limited.call({ path: `${API}/expensive` })).status, 200);
    const second = await limited.call({ path: `${API}/expensive` });
    assert.equal(second.status, 429);
    assert.equal(second.json?.code, "rate_limited");
    assert.equal((await limited.call({ path: `${API}/ping` })).status, 200);
  });

  test("error mapping: HttpError, ZodError, UnsafeUrlError and unexpected errors", async () => {
    const conflict = await loopback.call({ path: `${API}/conflict` });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.json, { error: "nope", code: "error" });

    const zod = await loopback.call({ path: `${API}/zod` });
    assert.equal(zod.status, 400);
    assert.equal(zod.json?.code, "validation");
    const issues = zod.json?.issues as { path: string; message: string }[];
    assert.equal(issues[0]?.path, "n");
    assert.ok(issues[0]?.message);

    const unsafe = await loopback.call({ path: `${API}/unsafe` });
    assert.equal(unsafe.status, 422);
    assert.equal(unsafe.json?.code, "unsafe_url");

    const boom = await loopback.call({ path: `${API}/boom` });
    assert.equal(boom.status, 500);
    assert.equal(boom.json?.code, "internal");
    assert.ok(!boom.text.includes("secret detail"), "internal error details must not reach the client");
  });

  test("security headers on every response; HEAD has an empty body", async () => {
    const responses = await Promise.all([
      loopback.call({ path: `${API}/ping` }),
      loopback.call({ path: `${API}/nope` }),
      loopback.call({ path: `${API}/boom` }),
      loopback.call({ method: "DELETE", path: `${API}/ping`, headers: MARKER }),
      loopback.call({ method: "OPTIONS", path: `${API}/ping` }),
      token.call({ path: `${API}/ping` }),
    ]);
    for (const r of responses) {
      assert.equal(r.headers["x-content-type-options"], "nosniff", `status ${r.status}`);
      assert.equal(r.headers["cache-control"], "no-store", `status ${r.status}`);
      assert.equal(r.headers["referrer-policy"], "no-referrer", `status ${r.status}`);
    }
    const head = await loopback.call({ method: "HEAD", path: `${API}/ping` });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.match(head.headers["content-type"] ?? "", /application\/json/);
  });
});
