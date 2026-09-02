/**
 * Extraction-quality heuristics. A scanned PDF yields little or no text;
 * treating that as an "empty résumé" would silently drop the user's best
 * document, so PDFs that fall below the thresholds are flagged NEEDS_OCR and
 * excluded from matching until fixed. Non-PDF formats get POOR instead.
 */
import type { ExtractionStatus, ResumeFormat } from "../types/entities.ts";

export interface QualityAssessment {
  quality: number;
  status: ExtractionStatus;
  notes: string[];
}

const ANCHORS: [RegExp, string][] = [
  [/\b(experience|employment|work history)\b/i, "experience section"],
  [/\b(education|degree|university|college)\b/i, "education section"],
  [/\b(skills|technologies|competencies)\b/i, "skills section"],
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "email address"],
  [/(\+?\d[\d\s().-]{7,}\d)/, "phone number"],
  [/\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|present|current)\b/i, "date range"],
];

// NUL bytes, replacement characters and pdf.js "(cid:NN)" glyph fallbacks mark unmapped text.
const GARBAGE_LINE = new RegExp("[" + String.fromCharCode(0) + "\\uFFFD]|\\(cid:\\d+\\)");

export function assessTextQuality(text: string, opts: { format: ResumeFormat; pageCount?: number }): QualityAssessment {
  const notes: string[] = [];
  const trimmed = text.replace(/\s+/g, " ").trim();
  const chars = trimmed.length;
  const letters = (trimmed.match(/\p{L}/gu) ?? []).length;
  const letterRatio = chars ? letters / chars : 0;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const avgWord = words.length ? words.join("").length / words.length : 0;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const garbageLines = lines.filter((l) => l.length === 1 || GARBAGE_LINE.test(l)).length;
  const garbageRatio = lines.length ? garbageLines / lines.length : 0;
  const anchorsFound = ANCHORS.filter(([re]) => re.test(text)).map(([, name]) => name);

  let quality = 0;
  quality += Math.min(40, Math.round((chars / 1500) * 40));
  if (chars < 200) notes.push("Very little text was extracted.");
  if (letterRatio >= 0.6) quality += 20;
  else if (letterRatio >= 0.45) quality += 10;
  else if (chars) notes.push("Extracted text has an unusually low share of letters (symbols, numbers or noise).");
  if (avgWord >= 2 && avgWord <= 12) quality += 10;
  else if (chars) notes.push("Average word length looks wrong; words may be broken or merged.");
  if (garbageRatio < 0.1) quality += 10;
  else notes.push("Many lines look like garbage (single characters or unmapped glyphs).");
  quality += Math.min(20, anchorsFound.length * 4);
  if (anchorsFound.length < 2 && chars) notes.push("Few résumé sections were recognised (experience, education, skills, contact, dates).");
  quality = Math.max(0, Math.min(100, quality));

  const perPage = opts.pageCount && opts.pageCount > 0 ? chars / opts.pageCount : chars;
  const tooThin = chars < 200 || letterRatio < 0.5 || (opts.pageCount !== undefined && opts.pageCount >= 1 && perPage < 150);
  let status: ExtractionStatus = "OK";
  if (tooThin) {
    status = opts.format === "pdf" ? "NEEDS_OCR" : "POOR";
    notes.unshift(
      opts.format === "pdf"
        ? "No usable text layer: this PDF looks scanned or image-only. Run OCR or export a text-based PDF, then re-index."
        : "Not enough readable text was extracted from this file.",
    );
  } else if (quality < 40) {
    status = "POOR";
    notes.unshift("Text was extracted but looks incomplete; a simpler single-column layout will index better.");
  }
  return { quality, status, notes };
}
