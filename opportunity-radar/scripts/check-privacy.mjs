#!/usr/bin/env node
/**
 * Privacy guard, run as part of `npm run lint`.
 *
 * Fails when private data could reach Git: the private folders must be
 * ignored, no résumé/database/env artefacts may be tracked, and the API layer
 * must not serialise résumé text. Cheap, deterministic, no dependencies.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const problems = [];

// 1. .gitignore must cover the private paths (module-level and repo-level).
const mustIgnore = ["private/", "data/", ".env", "*.sqlite"];
const localIgnore = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
for (const p of mustIgnore) {
  if (!localIgnore.split("\n").some((l) => l.trim() === p)) problems.push(`.gitignore is missing "${p}"`);
}

// 2. Nothing private may be tracked by Git (if we are inside a repo).
try {
  const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const bad = tracked.filter(
    (f) =>
      /^(private|data|dist)\//.test(f) ||
      /\.(sqlite|sqlite-wal|sqlite-shm|db)$/.test(f) ||
      /^\.env(\..+)?$/.test(f) && f !== ".env.example" ||
      /\.(pdf|docx)$/i.test(f),
  );
  for (const f of bad) problems.push(`tracked file should be private: ${f}`);
} catch {
  // Not a git checkout; skip.
}

// 3. Route handlers must never send `extractedText` to the browser.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const routesDir = join(root, "src", "http");
if (existsSync(routesDir)) {
  for (const file of walk(routesDir)) {
    const src = readFileSync(file, "utf8");
    if (/extractedText/.test(src) && !/toResumeSummary|omit\(|delete .*extractedText/.test(src)) {
      problems.push(`${relative(root, file)} references extractedText directly; use the summary projection`);
    }
  }
}

if (problems.length) {
  console.error("Privacy guard failed:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log("Privacy guard passed.");
