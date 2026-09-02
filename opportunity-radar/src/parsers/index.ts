/** Dispatches document extraction by format and attaches a quality assessment. */
import type { ExtractionStatus, ResumeFormat } from "../types/entities.ts";
import { extractPdfText } from "./pdf.ts";
import { extractDocxText } from "./docx.ts";
import { extractPlainText } from "./text.ts";
import { assessTextQuality } from "./quality.ts";

export interface ExtractionResult {
  text: string;
  status: ExtractionStatus;
  quality: number;
  notes: string[];
  pageCount: number | null;
}

export function formatFromFilename(name: string): ResumeFormat | null {
  const ext = name.toLowerCase().slice(name.lastIndexOf(".") + 1);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  return null;
}

export async function extractDocument(data: Uint8Array, format: ResumeFormat): Promise<ExtractionResult> {
  try {
    let text = "";
    let pageCount: number | null = null;
    if (format === "pdf") {
      const pdf = await extractPdfText(data);
      text = pdf.text;
      pageCount = pdf.pageCount;
    } else if (format === "docx") {
      text = extractDocxText(data);
    } else {
      text = extractPlainText(data, format);
    }
    const q = assessTextQuality(text, { format, pageCount: pageCount ?? undefined });
    return { text, status: q.status, quality: q.quality, notes: q.notes, pageCount };
  } catch (err) {
    return { text: "", status: "FAILED", quality: 0, notes: [`Could not parse the ${format.toUpperCase()} file: ${(err as Error)?.message ?? "unknown error"}`], pageCount: null };
  }
}

export { assessTextQuality } from "./quality.ts";
export { extractPdfText } from "./pdf.ts";
export { extractDocxText } from "./docx.ts";
export { extractPlainText } from "./text.ts";
