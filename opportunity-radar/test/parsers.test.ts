/**
 * Parser unit tests: the ZIP reader, DOCX and PDF extraction, plain-text and
 * Markdown normalisation, the extraction-quality heuristics and the format
 * dispatcher.
 *
 * Why: résumé parsing is the one place the app reads arbitrary binary input,
 * so each layer is exercised with documents built in memory from synthetic
 * content (test/helpers/documents.ts). Nothing here touches the filesystem
 * or the network, and no fixture is a real person's résumé.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { minimalDocx, minimalPdf, zipWith } from "./helpers/documents.ts";
import { readZipEntries } from "../src/parsers/zip.ts";
import { extractDocxText, wordXmlToText } from "../src/parsers/docx.ts";
import { extractPdfText } from "../src/parsers/pdf.ts";
import { extractPlainText } from "../src/parsers/text.ts";
import { assessTextQuality } from "../src/parsers/quality.ts";
import { extractDocument, formatFromFilename } from "../src/parsers/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const bytes = (s: string): Uint8Array => encoder.encode(s);

/** Deterministic bytes that are neither a ZIP nor a PDF (no random source, so failures reproduce). */
function junkBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
}

/** A synthetic résumé-like text (sections, e-mail, phone, date range) padded to at least `minChars`. */
function resumeLikeText(minChars: number): string {
  let text = [
    "Jordan Example",
    "jordan@example.com · (555) 010-0100",
    "",
    "Experience",
    "Senior Software Engineer — Example Corp (2020 – Present)",
    "Built TypeScript services on Node.js with PostgreSQL.",
    "",
    "Education",
    "B.S. Computer Science, Example State University, 2017",
    "",
    "Skills",
    "TypeScript, Node.js, PostgreSQL, AWS",
  ].join("\n");
  while (text.length < minChars) {
    text += "\nDesigned and shipped synthetic platform features with a distributed team, reviewing code and mentoring engineers.";
  }
  return text;
}

describe("zip: readZipEntries", () => {
  const entries = {
    "word/document.xml": "<w:document/>",
    "media/blob.bin": Uint8Array.from([0, 1, 2, 250, 255]),
    "notes.txt": "Jordan Example — synthetic note",
  };

  for (const method of ["store", "deflate"] as const) {
    test(`round-trips entry names and bytes through a ${method.toUpperCase()} archive`, () => {
      const read = readZipEntries(zipWith(entries, method));
      assert.deepEqual([...read.keys()].sort(), Object.keys(entries).sort());
      assert.deepEqual([...(read.get("media/blob.bin") ?? [])], [0, 1, 2, 250, 255]);
      assert.equal(decoder.decode(read.get("notes.txt")), "Jordan Example — synthetic note");
      assert.equal(decoder.decode(read.get("word/document.xml")), "<w:document/>");
    });
  }

  test("throws on garbage bytes", () => {
    assert.throws(() => readZipEntries(junkBytes(300)), /Malformed ZIP archive/);
    assert.throws(() => readZipEntries(new Uint8Array(5)), /too small to be a ZIP archive/);
  });

  test("throws on a truncated archive", () => {
    const zip = zipWith(entries, "deflate");
    // Tail cut off: the end-of-central-directory record is gone.
    assert.throws(() => readZipEntries(zip.subarray(0, zip.length - 10)), /Malformed ZIP archive/);
    // Head cut off: the directory offsets no longer point inside the buffer.
    assert.throws(() => readZipEntries(zip.subarray(10)), /Malformed ZIP archive/);
  });

  test("throws when an entry fails its CRC check", () => {
    const zip = zipWith({ "a.txt": "hello world" }, "store");
    const at = Buffer.from(zip).indexOf("hello world");
    assert.ok(at > 0);
    const corrupted = new Uint8Array(zip);
    corrupted[at] = "J".charCodeAt(0);
    assert.throws(() => readZipEntries(corrupted), /CRC/);
  });
});

describe("docx: extractDocxText", () => {
  const paragraphs = ["Jordan Example", "Skills\tTypeScript", "Line three"];

  test("returns paragraphs in order, newline-separated, with tabs preserved", () => {
    assert.equal(extractDocxText(minimalDocx(paragraphs)), "Jordan Example\nSkills\tTypeScript\nLine three");
  });

  test("reads a DEFLATE-compressed archive identically", () => {
    assert.equal(extractDocxText(minimalDocx(paragraphs, "deflate")), extractDocxText(minimalDocx(paragraphs, "store")));
  });

  test("throws when word/document.xml is missing", () => {
    assert.throws(() => extractDocxText(zipWith({ "[Content_Types].xml": "<Types/>" })), /word\/document\.xml/);
  });

  test("throws when the file is not a ZIP at all", () => {
    assert.throws(() => extractDocxText(junkBytes(200)), /Malformed ZIP archive/);
  });

  test("decodes XML entities", () => {
    assert.equal(extractDocxText(minimalDocx(["R&D <lead> & more"])), "R&D <lead> & more");
    assert.equal(wordXmlToText("<w:p><w:r><w:t>A &amp; B &lt; C &gt; D</w:t></w:r></w:p>"), "A & B < C > D");
  });

  test("joins table cells with tabs and rows with newlines", () => {
    const xml =
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Employer</w:t></w:r></w:p></w:tc></w:tr>" +
      "<w:tr><w:tc><w:p><w:r><w:t>Engineer</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Example Corp</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    assert.equal(wordXmlToText(xml), "Role\tEmployer\nEngineer\tExample Corp");
  });
});

describe("pdf: extractPdfText", () => {
  test("extracts the text lines and the page count", async () => {
    const { text, pageCount } = await extractPdfText(minimalPdf(["Senior TypeScript Engineer", "Node.js and SQL"]));
    assert.ok(text.includes("Senior TypeScript Engineer"), text);
    assert.ok(text.includes("Node.js and SQL"), text);
    assert.equal(pageCount, 1);
  });

  test("a page without text yields empty text, not an error", async () => {
    const { text, pageCount } = await extractPdfText(minimalPdf([]));
    assert.equal(text, "");
    assert.equal(pageCount, 1);
  });

  test("rejects garbage with a generic message", async () => {
    await assert.rejects(extractPdfText(junkBytes(200)), /PDF could not be parsed/);
  });
});

describe("text: extractPlainText", () => {
  test("strips a UTF-8 BOM and normalises line endings", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("Jordan Example\r\nSkills\rTypeScript")]);
    assert.equal(extractPlainText(withBom, "txt"), "Jordan Example\nSkills\nTypeScript");
  });

  test("leaves Markdown syntax alone for .txt", () => {
    assert.equal(extractPlainText(bytes("# Title\n**bold**"), "txt"), "# Title\n**bold**");
  });

  test("strips headings, emphasis and links from Markdown while keeping list items as lines", () => {
    const md = [
      "# Jordan Example",
      "",
      "**Senior** _Engineer_ at [Site](https://x)",
      "",
      "## Skills",
      "",
      "- item one",
      "* item two",
      "+ item three",
      "",
      "```",
      "code",
      "```",
    ].join("\n");
    assert.equal(
      extractPlainText(bytes(md), "md"),
      "Jordan Example\n\nSenior Engineer at Site\n\nSkills\n\n- item one\n- item two\n- item three\n\ncode",
    );
  });
});

describe("quality: assessTextQuality", () => {
  test("a résumé-like text with sections, e-mail and dates is OK with quality ≥ 60", () => {
    const text = resumeLikeText(2000);
    assert.ok(text.length >= 2000);
    for (const format of ["pdf", "docx", "txt", "md"] as const) {
      const q = assessTextQuality(text, format === "pdf" ? { format, pageCount: 2 } : { format });
      assert.equal(q.status, "OK", `${format}: ${q.notes.join(" | ")}`);
      assert.ok(q.quality >= 60, `${format}: quality ${q.quality}`);
    }
  });

  test("a 50-character PDF is NEEDS_OCR with a note mentioning OCR", () => {
    const short = "Jordan Example, software engineer at Example Corp.";
    assert.equal(short.length, 50);
    const q = assessTextQuality(short, { format: "pdf", pageCount: 1 });
    assert.equal(q.status, "NEEDS_OCR");
    assert.ok(q.notes.some((n) => /OCR/.test(n)), q.notes.join(" | "));
    assert.ok(q.quality < 60);
  });

  test("the same short text as .txt is POOR", () => {
    const q = assessTextQuality("Jordan Example, software engineer at Example Corp.", { format: "txt" });
    assert.equal(q.status, "POOR");
    assert.ok(q.notes.some((n) => /Not enough readable text/.test(n)), q.notes.join(" | "));
    assert.ok(!q.notes.some((n) => /OCR/.test(n)), "OCR advice is only for PDFs");
  });

  test("text that is mostly (cid:NN) garbage is flagged with the garbage note", () => {
    const garbage = Array.from({ length: 40 }, () => "(cid:12) (cid:13) (cid:14)").join("\n");
    const pdf = assessTextQuality(garbage, { format: "pdf", pageCount: 1 });
    assert.equal(pdf.status, "NEEDS_OCR");
    assert.ok(pdf.notes.some((n) => /garbage/.test(n)), pdf.notes.join(" | "));
    const docx = assessTextQuality(garbage, { format: "docx" });
    assert.equal(docx.status, "POOR");
    assert.ok(docx.notes.some((n) => /garbage/.test(n)), docx.notes.join(" | "));
  });

  test("fewer than 150 characters per page marks a PDF NEEDS_OCR", () => {
    let text = "";
    while (text.length < 300) text += "Experience education skills words here ";
    text = text.slice(0, 300);
    assert.equal(assessTextQuality(text, { format: "pdf", pageCount: 3 }).status, "NEEDS_OCR");
    // The same text on a single page clears the per-page threshold.
    assert.notEqual(assessTextQuality(text, { format: "pdf", pageCount: 1 }).status, "NEEDS_OCR");
  });
});

describe("extractDocument dispatch", () => {
  test("pdf with no text layer → NEEDS_OCR", async () => {
    const r = await extractDocument(minimalPdf([]), "pdf");
    assert.equal(r.status, "NEEDS_OCR");
    assert.equal(r.text, "");
    assert.equal(r.pageCount, 1);
  });

  test("docx → OK", async () => {
    const r = await extractDocument(minimalDocx(resumeLikeText(2000).split("\n")), "docx");
    assert.equal(r.status, "OK");
    assert.ok(r.quality >= 60);
    assert.ok(r.text.includes("Senior Software Engineer — Example Corp"));
    assert.equal(r.pageCount, null);
  });

  test("md → OK with Markdown stripped", async () => {
    const r = await extractDocument(bytes("# Jordan Example\n" + resumeLikeText(2000)), "md");
    assert.equal(r.status, "OK");
    assert.ok(r.text.startsWith("Jordan Example\n"));
    assert.ok(!r.text.includes("# "));
  });

  test("garbage pdf → FAILED with a note and empty text", async () => {
    const r = await extractDocument(junkBytes(100), "pdf");
    assert.equal(r.status, "FAILED");
    assert.equal(r.text, "");
    assert.equal(r.quality, 0);
    assert.equal(r.pageCount, null);
    assert.ok(r.notes.some((n) => /Could not parse the PDF file/.test(n)), r.notes.join(" | "));
  });

  test("garbage docx → FAILED without leaking bytes into the note", async () => {
    const r = await extractDocument(junkBytes(100), "docx");
    assert.equal(r.status, "FAILED");
    assert.equal(r.text, "");
    assert.ok(r.notes.some((n) => /Could not parse the DOCX file/.test(n)), r.notes.join(" | "));
  });

  test("formatFromFilename maps extensions case-insensitively and rejects unsupported ones", () => {
    const table: [string, ReturnType<typeof formatFromFilename>][] = [
      ["resume.PDF", "pdf"],
      ["Jordan Example.pdf", "pdf"],
      ["resume.docx", "docx"],
      ["resume.DOCX", "docx"],
      ["resume.md", "md"],
      ["resume.markdown", "md"],
      ["resume.txt", "txt"],
      ["resume.doc", null],
      ["scan.png", null],
      ["noextension", null],
    ];
    for (const [name, expected] of table) assert.equal(formatFromFilename(name), expected, name);
  });
});
