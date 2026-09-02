/** Types for the SSRF-safe fetcher (implemented in ./ssrf.ts). */

export interface SafeFetchOptions {
  /** Defaults to GET. Only GET/HEAD are allowed. */
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Accept only these content types (prefix match), e.g. ["text/html", "application/json"]. */
  acceptContentTypes?: string[];
  /** Skip the robots.txt check (used for the robots.txt fetch itself and JSON APIs). */
  skipRobots?: boolean;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  /** URL after redirects. */
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: string[];
  headers: Record<string, string>;
}

export type SafeFetcher = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>;

export class UnsafeUrlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "UnsafeUrlError";
    this.reason = reason;
  }
}

export class FetchPolicyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "FetchPolicyError";
    this.reason = reason;
  }
}
