/** Serves the UI from public/. Traversal-safe; unknown paths fall through. */
import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { RouteResponse } from "./router.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export async function serveStatic(publicDir: string, relativePath: string): Promise<RouteResponse | null> {
  const root = resolve(publicDir);
  const cleaned = normalize("/" + relativePath).replace(/^(\.\.[/\\])+/, "");
  const full = resolve(root, "." + cleaned);
  if (full !== root && !full.startsWith(root + sep)) return null;
  const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
  const type = TYPES[ext];
  if (!type) return null;
  try {
    const s = await stat(full);
    if (!s.isFile()) return null;
    const body = await readFile(full);
    return {
      status: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
      body,
    };
  } catch {
    return null;
  }
}

export function publicDirFrom(baseDir: string): string {
  return join(baseDir, "public");
}
