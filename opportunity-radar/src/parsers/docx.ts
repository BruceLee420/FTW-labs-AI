/**
 * DOCX text extraction without a dependency.
 *
 * Why: a résumé in Word format is a ZIP whose word/document.xml holds the
 * body as WordprocessingML. Matching and summarisation only need the visible
 * text with its paragraph structure, so this is deliberately a small
 * tokenizer rather than an XML parser: paragraph ends become newlines,
 * <w:tab/> a tab, <w:br/> and <w:cr/> a line break, table cells are joined
 * with tabs and table rows end with a newline. Only <w:t> runs contribute
 * characters; tracked deletions (<w:delText>), field codes (<w:instrText>)
 * and drawing fallbacks are dropped. Headers come first and footers last
 * because résumés often keep the name and contact block there.
 */
import { readZipEntries } from "./zip.ts";
import { decodeEntities } from "../utils/html.ts";

const utf8 = new TextDecoder("utf-8");

const TOKEN_RE =
  /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>|<w:cr(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;

/** Convert one WordprocessingML part (document, header or footer) to text. */
export function wordXmlToText(xml: string): string {
  const source = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  let out = "";
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(source))) {
    const token = m[0];
    if (m[1] !== undefined) {
      out += decodeEntities(m[1]);
    } else if (token.startsWith("<w:tab")) {
      out += "\t";
    } else if (token.startsWith("<w:br") || token.startsWith("<w:cr")) {
      out += "\n";
    } else if (token === "</w:tc>") {
      // A cell's last paragraph break becomes a tab so a row reads as one line.
      out = out.endsWith("\n") ? out.slice(0, -1) + "\t" : out + "\t";
    } else if (token === "</w:tr>") {
      out = out.endsWith("\t") ? out.slice(0, -1) + "\n" : out + "\n";
    } else {
      // </w:p> or an empty <w:p/>
      out += "\n";
    }
  }
  return tidy(out);
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract readable text from a DOCX file. Throws when the archive is not a
 * ZIP or has no word/document.xml.
 */
export function extractDocxText(data: Uint8Array): string {
  const entries = readZipEntries(data);
  const body = entries.get("word/document.xml");
  if (!body) throw new Error("DOCX is missing word/document.xml");

  const names = [...entries.keys()].sort();
  const headers = names.filter((n) => /^word\/header\d*\.xml$/.test(n));
  const footers = names.filter((n) => /^word\/footer\d*\.xml$/.test(n));
  const parts: string[] = [];
  for (const name of headers) parts.push(partText(entries, name));
  parts.push(wordXmlToText(utf8.decode(body)));
  for (const name of footers) parts.push(partText(entries, name));
  return tidy(parts.filter((p) => p.length > 0).join("\n\n"));
}

function partText(entries: Map<string, Uint8Array>, name: string): string {
  const bytes = entries.get(name);
  return bytes ? wordXmlToText(utf8.decode(bytes)) : "";
}
