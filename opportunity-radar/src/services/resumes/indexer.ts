/**
 * Indexes the private résumé folder. Files are read locally, hashed, parsed
 * into text, profiled deterministically and stored. Unchanged files (same
 * content hash) are skipped; files that disappeared are marked MISSING_FILE
 * rather than deleted, so the user's labels and tags survive.
 *
 * Paths never leave this module: profiles store the path RELATIVE to the
 * résumé root only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AppDeps } from "../../deps.ts";
import type { ResumeProfile, ResumeProfileSummary } from "../../types/entities.ts";
import { extractDocument, formatFromFilename } from "../../parsers/index.ts";
import { sha256Hex } from "../../utils/hash.ts";
import { newId } from "../../utils/ids.ts";
import { recordAudit } from "../audit.ts";
import { toResumeSummary } from "../opportunities.ts";
import { buildResumeProfile } from "./profile.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "logger" | "config">;

export interface IndexResult {
  indexed: number;
  skipped: number;
  failed: number;
  needsOcr: number;
  removed: number;
  dirExists: boolean;
  items: ResumeProfileSummary[];
  messages: string[];
}

const MAX_DEPTH = 3;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "output", "generated"]);

/** Recursively list supported files as paths relative to root (posix separators). */
export function listResumeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile() && formatFromFilename(name)) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root, 0);
  return out.sort();
}

export async function indexResumeFolder(deps: Deps, options: { force?: boolean } = {}, actor = "user"): Promise<IndexResult> {
  const root = deps.config.resumesDir;
  const result: IndexResult = { indexed: 0, skipped: 0, failed: 0, needsOcr: 0, removed: 0, dirExists: existsSync(root), items: [], messages: [] };
  if (!result.dirExists) {
    result.messages.push("The résumé folder does not exist yet. Create it (or set OPPORTUNITY_RADAR_RESUMES_DIR) and add PDF, DOCX, TXT or Markdown files.");
    result.items = deps.repos.resumes.listAll().map(toResumeSummary);
    return result;
  }
  const files = listResumeFiles(root);
  const seen = new Set<string>();
  for (const rel of files) {
    seen.add(rel);
    try {
      const outcome = await indexOne(deps, root, rel, options.force === true);
      if (outcome === "skipped") result.skipped++;
      else {
        result.indexed++;
        if (outcome === "NEEDS_OCR") result.needsOcr++;
        if (outcome === "FAILED") result.failed++;
      }
    } catch (err) {
      result.failed++;
      result.messages.push(`Could not index ${rel}: ${(err as Error)?.message ?? "error"}`);
      deps.logger.warn("resume index failed", { file: rel, error: (err as Error)?.name });
    }
  }
  for (const profile of deps.repos.resumes.listAll()) {
    if (!seen.has(profile.filename) && profile.extractionStatus !== "MISSING_FILE") {
      deps.repos.resumes.update(profile.id, { extractionStatus: "MISSING_FILE", isActive: false, extractionNotes: ["File no longer present in the résumé folder."] });
      recordAudit(deps.repos, deps.now, "resume", profile.id, "resume.missing", { filename: profile.filename }, "system");
      result.removed++;
    }
  }
  recordAudit(deps.repos, deps.now, "system", "resumes", "resumes.indexed", { indexed: result.indexed, skipped: result.skipped, failed: result.failed, needsOcr: result.needsOcr, removed: result.removed }, actor);
  result.items = deps.repos.resumes.listAll().map(toResumeSummary);
  if (!files.length) result.messages.push("No supported files found. Supported: .pdf, .docx, .txt, .md");
  return result;
}

async function indexOne(deps: Deps, root: string, rel: string, force: boolean): Promise<"skipped" | ResumeProfile["extractionStatus"]> {
  const full = join(root, rel);
  const st = statSync(full);
  if (st.size > MAX_FILE_BYTES) throw new Error("file larger than 25 MB");
  const format = formatFromFilename(rel)!;
  const data = readFileSync(full);
  const contentHash = sha256Hex(data);
  const existing = deps.repos.resumes.findByFilename(rel);
  if (existing && existing.contentHash === contentHash && !force && existing.extractionStatus !== "MISSING_FILE") return "skipped";

  const extraction = await extractDocument(new Uint8Array(data), format);
  const profile = buildResumeProfile(extraction.text, rel);
  const now = deps.now();
  const stored = deps.repos.resumes.upsertByFilename({
    id: existing?.id ?? newId(),
    filename: rel,
    format,
    label: existing?.label ?? profile.label,
    targetRoles: existing?.targetRoles.length ? existing.targetRoles : profile.targetRoles,
    skills: profile.skills,
    industries: profile.industries,
    experienceSummary: profile.experienceSummary,
    educationSummary: profile.educationSummary,
    verifiedFacts: profile.verifiedFacts,
    extractedText: extraction.text,
    extractionStatus: extraction.status,
    extractionQuality: extraction.quality,
    extractionNotes: extraction.notes,
    contentHash,
    fileSize: st.size,
    fileModifiedAt: st.mtime.toISOString(),
    lastIndexedAt: now,
    isActive: existing ? (existing.extractionStatus === "MISSING_FILE" ? true : existing.isActive) : extraction.status === "OK" || extraction.status === "POOR",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  recordAudit(deps.repos, deps.now, "resume", stored.id, existing ? "resume.reindexed" : "resume.indexed", {
    filename: rel,
    format,
    extractionStatus: extraction.status,
    extractionQuality: extraction.quality,
    characters: extraction.text.length,
  }, "system");
  return extraction.status;
}
