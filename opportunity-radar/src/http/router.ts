/**
 * Tiny path router. Patterns use `:name` segments. Handlers receive a
 * RouteContext and return a RouteResponse; anything thrown is mapped to an
 * HTTP error by app.ts.
 */
import type { IncomingHttpHeaders } from "node:http";

export interface RouteContext {
  method: string;
  url: URL;
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body (size-limited). Throws HttpError(400) on malformed JSON. */
  readJson(): Promise<unknown>;
  readText(): Promise<string>;
  actor: string;
  remoteAddress: string;
}

export interface RouteResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResponse> | RouteResponse;

export interface RouteOptions {
  /** Use the stricter "expensive" rate-limit bucket. */
  expensive?: boolean;
  /** Skip the auth guard (health only). */
  public?: boolean;
}

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
  options: RouteOptions;
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  options: RouteOptions;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler, options: RouteOptions = {}): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler, options });
    return this;
  }
  get(p: string, h: RouteHandler, o?: RouteOptions) {
    return this.add("GET", p, h, o);
  }
  post(p: string, h: RouteHandler, o?: RouteOptions) {
    return this.add("POST", p, h, o);
  }
  patch(p: string, h: RouteHandler, o?: RouteOptions) {
    return this.add("PATCH", p, h, o);
  }
  delete(p: string, h: RouteHandler, o?: RouteOptions) {
    return this.add("DELETE", p, h, o);
  }

  /** Returns the match, `"method"` when the path exists for another verb, or null. */
  match(method: string, pathname: string): RouteMatch | "method" | null {
    const parts = split(pathname);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) return { handler: route.handler, params, options: route.options };
    }
    return pathMatched ? "method" : null;
  }

  allowedMethods(pathname: string): string[] {
    const parts = split(pathname);
    return this.routes.filter((r) => matchSegments(r.segments, parts)).map((r) => r.method);
  }
}

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const v = parts[i]!;
    if (p.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(v);
      } catch {
        return null;
      }
      params[p.slice(1)] = decoded;
    } else if (p !== v) return null;
  }
  return params;
}
