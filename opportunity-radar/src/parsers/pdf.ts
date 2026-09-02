/**
 * PDF text extraction through unpdf (pdf.js without a worker or canvas).
 *
 * Why: this is the only parser that needs a library, and it is isolated here
 * so the rest of the pipeline never sees pdf.js types or exceptions. Any
 * parser failure is rethrown as a single generic Error; pdf.js messages can
 * echo bytes from the file, which must never reach logs or the browser.
 * A scanned PDF parses fine but yields no text: that case is not an error
 * here, the quality assessment turns it into NEEDS_OCR.
 */
import { extractText } from "unpdf";

export interface PdfText {
  text: string;
  pageCount: number;
}

export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  let result: { text: string; totalPages: number };
  try {
    // Copy: pdf.js may take ownership of the buffer it is handed.
    result = await extractText(new Uint8Array(data), { mergePages: true });
  } catch {
    throw new Error("PDF could not be parsed");
  }
  const text = typeof result.text === "string" ? result.text : "";
  const pageCount = Number.isFinite(result.totalPages) && result.totalPages > 0 ? Math.floor(result.totalPages) : 0;
  return { text, pageCount };
}
