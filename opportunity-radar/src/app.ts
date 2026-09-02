/**
 * Request pipeline: CORS → Host check → auth → rate limit → CSRF marker →
 * route → error mapping. Exported as a plain (req, res) handler so tests can
 * drive it without opening a port.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import type { AppDeps } from "./deps.ts";
import { HttpError } from "./utils/errors.ts";
import { Router, type RouteContext, type RouteResponse } from "./http/router.ts";
import { corsHeaders, MUTATING_METHODS, REQUEST_MARKER_HEADER } from "./http/cors.ts";
import { createAuthGuard, headerValue, isAllowedHost, type AuthGuard } from "./security/auth.ts";
import { createRateLimiter, unlimited, type RateLimiter } from "./security/rateLimit.ts";
import { AiInvalidOutputError, AiUnavailableError } from "./ai/provider.ts";
import { FetchPolicyError, UnsafeUrlError } from "./security/fetchTypes.ts";

const MAX_JSON_BYTES = 6 * 1024 * 1024;

export type RegisterRoutes = (router: Router, deps: AppDeps) => void;

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  router: Router;
}

export interface AppOptions {
  authGuard?: AuthGuard;
  generalLimiter?: RateLimiter;
  expensiveLimiter?: RateLimiter;
}

export function createApp(deps: AppDeps, registerRoutes: RegisterRoutes, options: AppOptions = {}): App {
  const router = new Router();
  registerRoutes(router, deps);
  const guard = options.authGuard ?? createAuthGuard(deps.config);
  const general =
    options.generalLimiter ?? (deps.config.rateLimitEnabled ? createRateLimiter({ capacity: 300, refillPerMinute: 300 }) : unlimited);
  const expensive =
    options.expensiveLimiter ?? (deps.config.rateLimitEnabled ? createRateLimiter({ capacity: 20, refillPerMinute: 20 }) : unlimited);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const origin = headerValue(req.headers.origin);
    const cors = corsHeaders(origin, deps.config.allowedOrigins);
    const remoteAddress = req.socket.remoteAddress ?? "";
    const base = `http://${headerValue(req.headers.host) || "localhost"}`;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", base);
    } catch {
      return send(res, { status: 400, body: JSON.stringify({ error: "Bad request." }) }, cors);
    }

    if (method === "OPTIONS") return send(res, { status: 204, body: null }, cors);

    try {
      if (!isAllowedHost(headerValue(req.headers.host), deps.config)) {
        throw new HttpError(421, "Host header is not allowed for this service.", "bad_host");
      }

      const matched = router.match(method, url.pathname);
      if (matched === "method") {
        throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      }
      if (!matched) throw new HttpError(404, "No such endpoint.", "not_found");

      let actor = "anonymous";
      if (!matched.options.public) {
        const auth = guard.authenticate({ headers: req.headers, remoteAddress });
        if (!auth) throw new HttpError(401, "Not authorised.", "unauthorized");
        actor = auth.actor;
        if (MUTATING_METHODS.has(method) && !headerValue(req.headers[REQUEST_MARKER_HEADER]) && !headerValue(req.headers.authorization)) {
          throw new HttpError(403, "Missing X-Radar-Request header.", "csrf");
        }
      }

      const limiterKey = remoteAddress || "unknown";
      if (!general.take(limiterKey)) throw new HttpError(429, "Slow down a moment, then try again.", "rate_limited");
      if (matched.options.expensive && !expensive.take(limiterKey)) {
        throw new HttpError(429, "Too many expensive requests; wait a minute and retry.", "rate_limited");
      }

      let bodyCache: Promise<string> | null = null;
      const readText = () => {
        if (!bodyCache) bodyCache = readBody(req, MAX_JSON_BYTES);
        return bodyCache;
      };
      const ctx: RouteContext = {
        method,
        url,
        params: matched.params,
        headers: req.headers,
        actor,
        remoteAddress,
        readText,
        async readJson() {
          const raw = await readText();
          if (!raw.trim()) return {};
          const type = (headerValue(req.headers["content-type"]) ?? "").split(";")[0]!.trim().toLowerCase();
          if (type && type !== "application/json") {
            throw new HttpError(415, "Send JSON with Content-Type: application/json.", "unsupported_media_type");
          }
          try {
            return JSON.parse(raw);
          } catch {
            throw new HttpError(400, "Malformed JSON body.", "bad_json");
          }
        },
      };

      const response = await matched.handler(ctx);
      return send(res, response, cors);
    } catch (err) {
      return send(res, errorResponse(err, deps), cors);
    }
  }

  return { handle, router };
}

function errorResponse(err: unknown, deps: AppDeps): RouteResponse {
  const body = (status: number, payload: Record<string, unknown>) => ({
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (err instanceof HttpError) {
    if (err.status >= 500) deps.logger.error(err.message, { code: err.code, detail: describe(err.detail) });
    return body(err.status, { error: err.message, code: err.code, ...(err.status < 500 && err.detail !== undefined ? { detail: err.detail } : {}) });
  }
  if (err instanceof ZodError) {
    return body(400, {
      error: "Validation failed.",
      code: "validation",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof UnsafeUrlError || err instanceof FetchPolicyError) {
    return body(422, { error: err.message, code: err.name === "UnsafeUrlError" ? "unsafe_url" : "fetch_policy" });
  }
  if (err instanceof AiUnavailableError) {
    return body(503, { error: err.message, code: "ai_unavailable" });
  }
  if (err instanceof AiInvalidOutputError) {
    return body(502, { error: err.message, code: "ai_invalid_output", issues: err.issues });
  }
  deps.logger.error("Unhandled error", { name: (err as Error)?.name, message: (err as Error)?.message });
  return body(500, { error: "Something went wrong on the server.", code: "internal" });
}

function describe(detail: unknown): unknown {
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
  return detail;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      total += chunk.length;
      if (total > limit) {
        // Reject and stop buffering, but keep draining the stream: destroying the
        // request here would reset the socket before the 413 could be written.
        overflow = true;
        chunks.length = 0;
        reject(new HttpError(413, "Request body too large.", "too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => reject(new HttpError(400, "Could not read request body.", "bad_body", e)));
  });
}

function send(res: ServerResponse, response: RouteResponse, cors: Record<string, string>): void {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    ...cors,
    ...(response.headers ?? {}),
  };
  if (headers["Content-Type"]?.startsWith("text/html")) {
    headers["Content-Security-Policy"] =
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
  }
  res.writeHead(response.status, headers);
  if (response.body === null || response.body === undefined || res.req.method === "HEAD") res.end();
  else res.end(response.body);
}
