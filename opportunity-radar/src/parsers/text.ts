/**
 * Plain-text and Markdown extraction.
 *
 * Why: .txt and .md résumés need no parsing, only normalisation so the
 * downstream heuristics see the same shape as PDF/DOCX output: UTF-8 with
 * the byte-order mark removed and Unix line endings. For Markdown the
 * syntax is stripped lightly (headings, emphasis, links, code fences,
 * block quotes, table rules) while list items stay on their own lines so
 * section structure survives. Invalid UTF-8 bytes become U+FFFD, which the
 * quality assessment then counts against the text.
 */

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function extractPlainText(data: Uint8Array, format: "txt" | "md"): string {
  let text = utf8.decode(data);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  return format === "md" ? stripMarkdown(text) : text;
}

/** Remove Markdown syntax while keeping the readable text and line structure. */
export function stripMarkdown(markdown: string): string {
  const out: string[] = [];
  let previousBlank = true;
  for (const raw of markdown.split("\n")) {
    let line = raw;
    if (/^\s*(```|~~~)/.test(line)) continue; // code fence markers
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue; // horizontal rule
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // table rule
    if (/^\s*(=+|-+)\s*$/.test(line) && !previousBlank) continue; // setext underline
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^(\s*)[*+]\s+/, "$1- ")
      .replace(/^(\s*)-\s+\[[ xX]\]\s+/, "$1- ")
      .replace(/^\s*\|\s*/, "")
      .replace(/\s*\|\s*$/, "");
    line = stripInline(line);
    const blank = line.trim() === "";
    if (blank && previousBlank) continue;
    out.push(line.replace(/\s+$/, ""));
    previousBlank = blank;
  }
  return out.join("\n").trim();
}

function stripInline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:b|i|em|strong|u|p|div|span|a|ul|ol|li|h[1-6]|sup|sub|small)\b[^>]*>/gi, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1")
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1");
}
