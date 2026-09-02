import type { RouteResponse } from "./router.ts";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): RouteResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(data) };
}

export function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): RouteResponse {
  return { status, headers: { "Content-Type": contentType }, body };
}

export function html(body: string, status = 200): RouteResponse {
  return text(body, status, "text/html; charset=utf-8");
}

export function csv(body: string, filename: string): RouteResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    },
    body,
  };
}

export function noContent(): RouteResponse {
  return { status: 204, body: null };
}

export function redirect(location: string, status = 302): RouteResponse {
  return { status, headers: { Location: location }, body: null };
}
