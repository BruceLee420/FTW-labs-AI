/**
 * Résumé retrieval. The MVP is deterministic keyword/skill overlap, which is
 * transparent and needs no model. `ResumeRetriever` is the seam for a vector
 * retriever later; callers only ever see ranked candidates.
 */
import type { Opportunity, ResumeProfile } from "../types/entities.ts";
import { tokenize, uniqueStrings } from "../utils/text.ts";

export interface ResumeCandidate {
  resume: ResumeProfile;
  /** 0–100 */
  score: number;
  matchedSkills: string[];
  matchedRoles: string[];
  rationale: string;
}

export interface ResumeRetriever {
  retrieve(opportunity: Opportunity, resumes: ResumeProfile[], limit: number): ResumeCandidate[];
}

const STOP = new Set([
  "and", "the", "for", "with", "you", "our", "are", "will", "have", "this", "that", "your", "from", "who", "can",
  "all", "not", "but", "role", "team", "work", "job", "we", "to", "of", "in", "on", "as", "or", "an", "be", "is",
  "at", "by", "it", "us", "experience", "years", "ability", "strong", "skills", "including", "etc", "plus",
]);

function skillKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export class KeywordResumeRetriever implements ResumeRetriever {
  retrieve(opportunity: Opportunity, resumes: ResumeProfile[], limit = 3): ResumeCandidate[] {
    const usable = resumes.filter((r) => r.isActive && r.extractionStatus !== "NEEDS_OCR" && r.extractionStatus !== "FAILED");
    const required = new Set(opportunity.requiredSkills.map(skillKey));
    const preferred = new Set(opportunity.preferredSkills.map(skillKey));
    const titleTokens = tokenize(opportunity.title).filter((t) => !STOP.has(t));
    const descTokens = new Set(
      tokenize(opportunity.normalizedDescription || opportunity.rawDescription).filter((t) => t.length > 3 && !STOP.has(t)),
    );
    const maxPossible = required.size * 3 + preferred.size * 1.5 + Math.min(titleTokens.length, 4) * 4 + 10;

    const candidates = usable.map((resume) => {
      const resumeSkills = new Set(resume.skills.map(skillKey));
      const matchedRequired = [...required].filter((s) => resumeSkills.has(s) || textHas(resume.extractedText, s));
      const matchedPreferred = [...preferred].filter((s) => resumeSkills.has(s) || textHas(resume.extractedText, s));
      const roleTokens = new Set(resume.targetRoles.flatMap((r) => tokenize(r)));
      const matchedRoles = titleTokens.filter((t) => roleTokens.has(t));
      const resumeTokens = new Set(tokenize(resume.extractedText));
      let overlap = 0;
      for (const t of descTokens) if (resumeTokens.has(t)) overlap++;
      const raw =
        matchedRequired.length * 3 +
        matchedPreferred.length * 1.5 +
        Math.min(matchedRoles.length, 4) * 4 +
        Math.min(overlap, 50) * 0.2;
      const score = maxPossible > 0 ? Math.round(Math.min(100, (raw / maxPossible) * 100)) : 0;
      const matchedSkills = uniqueStrings([...matchedRequired, ...matchedPreferred]);
      const rationale = buildRationale(resume, matchedRequired.length, required.size, matchedPreferred.length, matchedRoles, overlap);
      return { resume, score, matchedSkills, matchedRoles: uniqueStrings(matchedRoles), rationale };
    });

    return candidates.sort((a, b) => b.score - a.score || a.resume.label.localeCompare(b.resume.label)).slice(0, limit);
  }
}

function textHas(text: string, term: string): boolean {
  if (!term || term.length < 2) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}

function buildRationale(
  resume: ResumeProfile,
  reqHits: number,
  reqTotal: number,
  prefHits: number,
  roles: string[],
  overlap: number,
): string {
  const parts: string[] = [];
  if (reqTotal) parts.push(`${reqHits}/${reqTotal} required skills`);
  if (prefHits) parts.push(`${prefHits} preferred skills`);
  if (roles.length) parts.push(`title matches target role (${roles.join(", ")})`);
  if (overlap) parts.push(`${overlap} shared description terms`);
  return parts.length ? `${resume.label}: ${parts.join("; ")}.` : `${resume.label}: no direct keyword overlap.`;
}

export const defaultRetriever: ResumeRetriever = new KeywordResumeRetriever();
