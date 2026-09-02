/**
 * SSRF-safe fetching for the "paste a URL" flow and the source adapters.
 *
 * Every URL (including every redirect hop) is validated (scheme, no
 * credentials, no local names, denylist) and DNS-resolved with every
 * returned address checked against private/reserved ranges. Only GET/HEAD
 * are ever issued. Bodies are streamed with a byte cap; the whole operation
 * runs under one timeout. robots.txt is honoured per origin.
 *
 * Residual risk (documented): DNS answers can change between the check and
 * the connect (rebinding). The byte and time caps bound what such a request
 * could return, and no request ever carries credentials.
 */
import { lookup } from "node:dns/promises";
import type { RadarConfig } from "../config.ts";
import { FetchPolicyError, UnsafeUrlError, type SafeFetcher, type SafeFetchOptions, type SafeFetchResult } from "./fetchTypes.ts";
import { denylistReason } from "./denylist.ts";
import { isBlockedAddress, parseIp } from "./ipRanges.ts";
import { parseRobots, type Robots } from "./robots.ts";

export const USER_AGENT = "FTWOpportunityRadar/0.1 (+https://ftwlabs.ai)";
export const ROBOTS_AGENT = "FTWOpportunityRadar";

export interface ValidateOptions {
  denylist?: string[];
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan", ".intranet", ".corp", ".localdomain"];

export function validateTargetUrl(input: string, options: ValidateOptions = {}): URL {
  if (typeof input !== "string" || input.length > 2048) throw new UnsafeUrlError("URL is missing or too long.");
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeUrlError("Not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http and https URLs can be fetched.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with embedded credentials are refused.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("URL has no host.");
  if (url.port === "0") throw new UnsafeUrlError("Port 0 is not allowed.");
  const bare = host.replace(/^\[|\]$/g, "");
  if (parseIp(bare)) {
    if (isBlockedAddress(bare)) throw new UnsafeUrlError("That address points at a private or reserved network and will not be fetched.");
  } else {
    if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) throw new UnsafeUrlError("Local hostnames are never fetched.");
    if (!host.includes(".")) throw new UnsafeUrlError("Single-label hostnames are never fetched.");
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new UnsafeUrlError("Numeric host spellings are refused.");
  }
  const reason = denylistReason(host, options.denylist ?? []);
  if (reason) throw new FetchPolicyError(reason);
  return url;
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function resolveSafely(hostname: string, lookupFn: LookupFn = defaultLookup): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (parseIp(bare)) {
    if (isBlockedAddress(bare)) throw new UnsafeUrlError("That address points at a private or reserved network.");
    return [bare];
  }
  let records: { address: string; family: number }[];
  try {
    records = await lookupFn(bare);
  } catch {
    throw new UnsafeUrlError("The hostname could not be resolved.");
  }
  if (!records.length) throw new UnsafeUrlError("The hostname did not resolve to any address.");
  for (const r of records) {
    if (isBlockedAddress(r.address)) throw new UnsafeUrlError("The hostname resolves to a private or reserved address and will not be fetched.");
  }
  return records.map((r) => r.address);
}

export interface SafeFetcherOptions {
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  userAgent?: string;
}

type FetchConfig = Pick<RadarConfig, "fetchMaxBytes" | "fetchMaxRedirects" | "fetchTimeoutMs" | "urlDenylist">;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCK_MARKERS = /captcha|cf-chl|please verify you are human|sign in to continue|log in to continue|access denied/i;

export function createSafeFetcher(config: FetchConfig, options: SafeFetcherOptions = {}): SafeFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupFn = options.lookup ?? defaultLookup;
  const userAgent = options.userAgent ?? USER_AGENT;
  const robotsCache = new Map<string, Promise<Robots>>();

  async function robotsFor(origin: string, signal: AbortSignal): Promise<Robots> {
    let cached = robotsCache.get(origin);
    if (!cached) {
      cached = (async () => {
        try {
          const res = await fetchImpl(`${origin}/robots.txt`, { method: "GET", redirect: "manual", signal, headers: { "User-Agent": userAgent, Accept: "text/plain" } });
          if (!res.ok) return parseRobots("");
          const text = await readCapped(res, 200_000);
          return parseRobots(text.body);
        } catch {
          return parseRobots("");
        }
      })();
      robotsCache.set(origin, cached);
    }
    return cached;
  }

  return async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const method = opts.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") throw new FetchPolicyError("Only GET and HEAD requests are permitted.");
    const maxBytes = opts.maxBytes ?? config.fetchMaxBytes;
    const maxRedirects = opts.maxRedirects ?? config.fetchMaxRedirects;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.fetchTimeoutMs);
    const redirects: string[] = [];
    try {
      let current = validateTargetUrl(input, { denylist: config.urlDenylist });
      for (let hop = 0; ; hop++) {
        await resolveSafely(current.hostname, lookupFn);
        if (!opts.skipRobots) {
          const robots = await robotsFor(current.origin, controller.signal);
          if (!robots.isAllowed(current.pathname + current.search, ROBOTS_AGENT)) {
            throw new FetchPolicyError("robots.txt disallows fetching this path; open it in your browser and enter the details manually.");
          }
        }
        let res: Response;
        try {
          res = await fetchImpl(current.toString(), {
            method,
            redirect: "manual",
            signal: controller.signal,
            headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.5", "Accept-Language": "en", ...(opts.headers ?? {}) },
          });
        } catch (err) {
          if (controller.signal.aborted) throw new FetchPolicyError("The page took too long to respond.");
          throw new FetchPolicyError("The page could not be reached.");
        }
        if (REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get("location");
          if (!location) throw new FetchPolicyError("Redirect without a destination.");
          if (hop >= maxRedirects) throw new FetchPolicyError("Too many redirects.");
          const next = validateTargetUrl(new URL(location, current).toString(), { denylist: config.urlDenylist });
          redirects.push(next.toString());
          try {
            await res.body?.cancel();
          } catch {
            /* ignore */
          }
          current = next;
          continue;
        }
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (opts.acceptContentTypes && opts.acceptContentTypes.length && res.status < 400) {
          const base = contentType.split(";")[0]!.trim();
          if (!opts.acceptContentTypes.some((t) => base.startsWith(t.toLowerCase()))) {
            throw new FetchPolicyError(`Unexpected content type (${base || "unknown"}).`);
          }
        }
        const { body, truncated } = method === "HEAD" ? { body: "", truncated: false } : await readCapped(res, maxBytes);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        if (res.status === 401 || res.status === 403 || BLOCK_MARKERS.test(body.slice(0, 20000))) headers["x-radar-access-block"] = "login-or-captcha";
        return { ok: res.status >= 200 && res.status < 300, status: res.status, finalUrl: current.toString(), contentType, body, truncated, redirects, headers };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks)), truncated };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
