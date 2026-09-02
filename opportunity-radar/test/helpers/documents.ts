/**
 * Builders for synthetic test documents: a minimal valid PDF (text or empty),
 * a minimal DOCX, and a tiny ZIP writer (STORE or DEFLATE). No real personal
 * data anywhere.
 */
import { crc32, deflateRawSync } from "node:zlib";

export function minimalPdf(lines: string[]): Uint8Array {
  const content = lines.map((l, i) => `BT /F1 12 Tf 40 ${740 - i * 16} Td (${l.replace(/[()\\]/g, (c) => "\\" + c)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

function le16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

export function zipWith(entries: Record<string, Uint8Array | string>, method: "store" | "deflate" = "store"): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const data = typeof raw === "string" ? new Uint8Array(Buffer.from(raw, "utf8")) : raw;
    const nameBytes = [...Buffer.from(name, "utf8")];
    const crc = crc32(data);
    const stored = method === "deflate" ? new Uint8Array(deflateRawSync(data)) : data;
    const methodCode = method === "deflate" ? 8 : 0;
    const local = [
      ...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(methodCode), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(stored.length), ...le32(data.length), ...le16(nameBytes.length), ...le16(0), ...nameBytes,
    ];
    parts.push(...local, ...stored);
    central.push(
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(methodCode), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(stored.length), ...le32(data.length), ...le16(nameBytes.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...nameBytes,
    );
    offset += local.length + stored.length;
  }
  const count = Object.keys(entries).length;
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(count), ...le16(count), ...le32(central.length), ...le32(offset), ...le16(0)];
  return new Uint8Array([...parts, ...central, ...eocd]);
}

const XML_ESC = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function minimalDocx(paragraphs: string[], method: "store" | "deflate" = "store"): Uint8Array {
  const body = paragraphs
    .map((p) => {
      const runs = p.split("\t").map((seg, i) => `${i ? "<w:tab/>" : ""}<w:t xml:space="preserve">${XML_ESC(seg)}</w:t>`).join("");
      return `<w:p><w:r>${runs}</w:r></w:p>`;
    })
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zipWith(
    {
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": document,
    },
    method,
  );
}
