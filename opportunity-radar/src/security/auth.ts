/**
 * Authentication guards.
 *
 * The service is local-first: by default it binds to loopback and trusts
 * connections that arrive from loopback with a loopback Host header (which
 * defeats DNS rebinding). When OPPORTUNITY_RADAR_AUTH_TOKEN is set, every
 * request must carry it as a bearer token — required for any non-loopback bind.
 *
 * `AuthGuard` is an interface so a Cloudflare Access verifier (the model the
 * rest of the site uses) can be added without touching the routes.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { RadarConfig } from "../config.ts";
import { isLoopbackHost } from "../config.ts";

export interface AuthRequest {
  headers: IncomingHttpHeaders;
  remoteAddress: string;
}

export interface AuthResult {
  actor: string;
}

export interface AuthGuard {
  readonly id: string;
  authenticate(req: AuthRequest): AuthResult | null;
}

export function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, "");
  return a === "::1" || a === "127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Host header must name this service (loopback or an allowlisted origin host). */
export function isAllowedHost(hostHeader: string | undefined, config: RadarConfig): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const host = m[1]!.replace(/^\[|\]$/g, "");
  const port = m[2] ? Number(m[2]) : null;
  const portOk = port === null || port === config.port;
  if (isLoopbackHost(host) && portOk) return true;
  if (host === config.host.toLowerCase() && portOk) return true;
  return config.allowedOrigins.some((o) => {
    try {
      const u = new URL(o);
      return u.hostname.toLowerCase() === host && (u.port === "" ? portOk : Number(u.port) === port);
    } catch {
      return false;
    }
  });
}

export class LoopbackGuard implements AuthGuard {
  readonly id = "loopback";
  private readonly config: RadarConfig;
  constructor(config: RadarConfig) {
    this.config = config;
  }
  authenticate(req: AuthRequest): AuthResult | null {
    if (!isLoopbackAddress(req.remoteAddress)) return null;
    if (!isAllowedHost(headerValue(req.headers.host), this.config)) return null;
    return { actor: "local-user" };
  }
}

export class TokenGuard implements AuthGuard {
  readonly id = "token";
  private readonly token: Buffer;
  constructor(token: string) {
    this.token = Buffer.from(token, "utf8");
  }
  authenticate(req: AuthRequest): AuthResult | null {
    const header = headerValue(req.headers.authorization) ?? "";
    const m = header.match(/^Bearer\s+(.+)$/i);
    const presented = m ? m[1]!.trim() : headerValue(req.headers["x-radar-token"]) ?? "";
    if (!presented) return null;
    const buf = Buffer.from(presented, "utf8");
    if (buf.length !== this.token.length) return null;
    return timingSafeEqual(buf, this.token) ? { actor: "token-user" } : null;
  }
}

export function createAuthGuard(config: RadarConfig): AuthGuard {
  return config.authToken ? new TokenGuard(config.authToken) : new LoopbackGuard(config);
}

export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
