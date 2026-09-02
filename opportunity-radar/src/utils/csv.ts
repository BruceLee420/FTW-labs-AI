/** Minimal RFC 4180 CSV writer and reader. */

export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Leading = + - @ can be interpreted as formulas by spreadsheet apps.
  const guarded = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const head = headers.map(csvEscape).join(",");
  const body = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

/** Parse CSV text into rows of strings. Handles quotes, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Rows to objects keyed by the header row (trimmed, case preserved). */
export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows.shift()?.map((h) => h.trim()) ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}
