/**
 * CORS for the dashboard widget. Only allowlisted origins get headers; a
 * request from anywhere else receives no CORS grant and the browser blocks
 * the response. Mutating requests must carry `X-Radar-Request`, which forces a
 * preflight so a cross-site form post cannot reach a state-changing route.
 */

export const REQUEST_MARKER_HEADER = "x-radar-request";

export function corsHeaders(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  if (!origin) return {};
  const normalized = origin.replace(/\/$/, "").toLowerCase();
  const allowed = allowedOrigins.some((o) => o.replace(/\/$/, "").toLowerCase() === normalized);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Radar-Request",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
