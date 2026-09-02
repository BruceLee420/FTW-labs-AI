/** In-memory token-bucket limiter keyed by client. Abuse dampening, not a quota. */

export interface RateLimiter {
  /** Returns true when the request may proceed. */
  take(key: string, now?: number): boolean;
  reset(): void;
}

export interface RateLimitOptions {
  capacity: number;
  refillPerMinute: number;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  const refillPerMs = options.refillPerMinute / 60_000;
  return {
    take(key, now = Date.now()) {
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: options.capacity, updated: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(options.capacity, b.tokens + (now - b.updated) * refillPerMs);
      b.updated = now;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      if (buckets.size > 10_000) buckets.clear();
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}

export const unlimited: RateLimiter = { take: () => true, reset() {} };
