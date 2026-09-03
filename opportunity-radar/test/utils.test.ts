/**
 * Pure utility helpers: CSV, URL canonicalisation, text normalisation, HTML
 * extraction, time arithmetic, ids and hashing. No I/O.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { csvEscape, csvToObjects, parseCsv, toCsv } from "../src/utils/csv.ts";
import { canonicalizeUrl, domainOf, hostedAtsName, hostnameOf, registrableDomain } from "../src/utils/url.ts";
import { collapseWhitespace, lines, normalizeCompanyName, normalizeTitle, stripDiacritics, tokenize, truncate, uniqueStrings } from "../src/utils/text.ts";
import { decodeEntities, escapeHtml, extractCanonical, extractJsonLd, extractMeta, extractTitleTag, htmlToText } from "../src/utils/html.ts";
import { addDays, isoDate, isPastOrNow, nowIso } from "../src/utils/time.ts";
import { isValidId, newId } from "../src/utils/ids.ts";
import { sha256Hex, shortHash } from "../src/utils/hash.ts";

// -------------------------------------------------------------------- csv

describe("csv", () => {
  test("csvEscape quotes commas, quotes and line breaks", () => {
    assert.equal(csvEscape("plain"), "plain");
    assert.equal(csvEscape("a,b"), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape("line\nbreak"), '"line\nbreak"');
    assert.equal(csvEscape("cr\rhere"), '"cr\rhere"');
    assert.equal(csvEscape(null), "");
    assert.equal(csvEscape(undefined), "");
    assert.equal(csvEscape(42), "42");
    assert.equal(csvEscape(false), "false");
  });

  test("formula guard prefixes a leading = + - @", () => {
    assert.equal(csvEscape("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(csvEscape("+1"), "'+1");
    assert.equal(csvEscape("-1"), "'-1");
    assert.equal(csvEscape("@x"), "'@x");
    assert.equal(csvEscape("=1,2"), "\"'=1,2\"");
    assert.equal(csvEscape("a=b"), "a=b");
  });

  test("parseCsv handles quoted commas, escaped quotes and CRLF", () => {
    assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\r\n'), [
      ["a", "b,c", 'd "e"'],
      ["1", "2", "3"],
    ]);
    assert.deepEqual(parseCsv('x,"multi\nline",y\n'), [["x", "multi\nline", "y"]]);
    assert.deepEqual(parseCsv("a,b\n1,2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
    assert.deepEqual(parseCsv("a,b\n\n1,2\n"), [
      ["a", "b"],
      ["1", "2"],
    ]);
    assert.deepEqual(parseCsv(""), []);
  });

  test("parseCsv strips a leading BOM", () => {
    assert.deepEqual(parseCsv("﻿a,b\n1,2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("csvToObjects maps rows onto the trimmed header", () => {
    assert.deepEqual(csvToObjects(" title , company \nEngineer, Northwind \nPM"), [
      { title: "Engineer", company: "Northwind" },
      { title: "PM", company: "" },
    ]);
    assert.deepEqual(csvToObjects(""), []);
  });

  test("toCsv → parseCsv round trip", () => {
    const headers = ["name", "note", "count"];
    const rows: unknown[][] = [
      ["Jordan Example", 'said "hi", left', 3],
      ["Sam Example", "x\ny", null],
    ];
    const text = toCsv(headers, rows);
    assert.ok(text.endsWith("\r\n"));
    assert.deepEqual(parseCsv(text), [headers, ["Jordan Example", 'said "hi", left', "3"], ["Sam Example", "x\ny", ""]]);
    assert.equal(toCsv(["a", "b"], []), "a,b\r\n");
  });

  test("round trip keeps the formula guard prefix (by design)", () => {
    assert.deepEqual(parseCsv(toCsv(["v"], [["=cmd|calc"]])), [["v"], ["'=cmd|calc"]]);
  });
});

// -------------------------------------------------------------------- url

describe("url", () => {
  test("canonicalizeUrl normalises host, port, params, fragment and trailing slash", () => {
    assert.equal(canonicalizeUrl("HTTPS://WWW.Example.com:443/jobs/?utm_source=x&b=2&a=1&fbclid=y#frag"), "https://example.com/jobs/?a=1&b=2");
    assert.equal(canonicalizeUrl("https://example.com/jobs/"), "https://example.com/jobs");
    assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
    assert.equal(canonicalizeUrl("http://example.com:80/x"), "http://example.com/x");
    assert.equal(canonicalizeUrl("https://example.com:8443/x"), "https://example.com:8443/x");
    assert.equal(canonicalizeUrl("https://example.com/x?ref=abc&gclid=1&UTM_MEDIUM=m"), "https://example.com/x");
    assert.equal(canonicalizeUrl("  https://example.com/x  "), "https://example.com/x");
    assert.equal(canonicalizeUrl("https://example.com/x?z=1&a=2"), "https://example.com/x?a=2&z=1");
  });

  test("canonicalizeUrl rejects non-http schemes and garbage", () => {
    assert.equal(canonicalizeUrl("mailto:jordan@example.com"), null);
    assert.equal(canonicalizeUrl("ftp://example.com/x"), null);
    assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
    assert.equal(canonicalizeUrl("not a url"), null);
  });

  test("registrableDomain (best effort, no PSL)", () => {
    assert.equal(registrableDomain("example.com"), "example.com");
    assert.equal(registrableDomain("jobs.example.co.uk"), "example.co.uk");
    assert.equal(registrableDomain("boards.greenhouse.io"), "greenhouse.io");
    assert.equal(registrableDomain("a.b.c.example.com"), "example.com");
    assert.equal(registrableDomain("Example.COM."), "example.com");
    assert.equal(registrableDomain("localhost"), "localhost");
  });

  test("hostedAtsName, hostnameOf and domainOf", () => {
    assert.equal(hostedAtsName("https://jobs.lever.co/x"), "Lever");
    assert.equal(hostedAtsName("https://boards.greenhouse.io/acme/jobs/1"), "Greenhouse");
    assert.equal(hostedAtsName("https://acme.example/careers"), null);
    assert.equal(hostedAtsName(null), null);
    assert.equal(hostedAtsName("garbage"), null);
    assert.equal(hostnameOf("https://Jobs.Example.com/x"), "jobs.example.com");
    assert.equal(hostnameOf(undefined), null);
    assert.equal(domainOf("https://jobs.example.co.uk/x"), "example.co.uk");
    assert.equal(domainOf("nope"), null);
  });
});

// ------------------------------------------------------------------- text

describe("text", () => {
  test("normalizeCompanyName strips punctuation, legal suffixes and diacritics", () => {
    assert.equal(normalizeCompanyName("Acme, Inc."), "acme");
    assert.equal(normalizeCompanyName("Northwind Analytics LLC"), "northwind analytics");
    assert.equal(normalizeCompanyName("Café Ñandú GmbH"), "cafe nandu");
    assert.equal(normalizeCompanyName("  Contoso   Freight Ltd. "), "contoso freight");
    assert.equal(normalizeCompanyName("Northwind"), normalizeCompanyName("NORTHWIND Corporation"));
  });

  test("normalizeTitle removes parentheticals and job-title noise but keeps seniority", () => {
    assert.equal(normalizeTitle("Senior Software Engineer (Remote)"), "senior software engineer");
    assert.equal(normalizeTitle("Software Engineer - Remote, US - Full-Time"), "software engineer");
    assert.equal(normalizeTitle("Engineer II [Contract] 2026"), "engineer");
    assert.equal(normalizeTitle("C++ Developer"), "c++ developer");
    assert.equal(normalizeTitle("Data Entry Clerk - Work From Home - Immediate Start"), "data entry clerk start");
  });

  test("tokenize keeps c++, c# and node.js", () => {
    assert.deepEqual(tokenize("C++ and C# with Node.js, .NET; a bb"), ["c++", "and", "c#", "with", "node.js", "net", "bb"]);
    assert.deepEqual(tokenize("Résumé écrit"), ["resume", "ecrit"]);
    assert.deepEqual(tokenize(""), []);
  });

  test("uniqueStrings is case-insensitive and trims", () => {
    assert.deepEqual(uniqueStrings(["TypeScript", "typescript", " Node.js ", "node.js", "", "  ", "TYPESCRIPT"]), ["TypeScript", "Node.js"]);
    assert.deepEqual(uniqueStrings(new Set(["a", "A"])), ["a"]);
  });

  test("lines strips bullets and blank lines", () => {
    assert.deepEqual(lines("• one\n- two\r\n  * three\n\n— four\n· five\n   "), ["one", "two", "three", "four", "five"]);
  });

  test("truncate, collapseWhitespace, stripDiacritics", () => {
    assert.equal(truncate("abcdef", 4), "abc…");
    assert.equal(truncate("abc", 5), "abc");
    assert.equal(truncate("ab cd", 4), "ab…");
    assert.equal(collapseWhitespace("  a \n\t b  "), "a b");
    assert.equal(stripDiacritics("Zoë Ångström"), "Zoe Angstrom");
  });
});

// ------------------------------------------------------------------- html

describe("html", () => {
  const HTML =
    "<html><head><title>T &amp; Co</title><style>.x{color:red}</style><script>var a=1;</script></head>" +
    "<body><h1>Hello &amp; welcome</h1><p>It&#39;s &#x27;here&#x27;<br>next</p><ul><li>One</li><li>Two</li></ul><!-- hidden --><noscript>ns</noscript><div>tail</div></body></html>";

  test("htmlToText drops script/style/comments, keeps block breaks and bullets, decodes entities", () => {
    const text = htmlToText(HTML);
    assert.ok(!text.includes("var a=1"));
    assert.ok(!text.includes("color:red"));
    assert.ok(!text.includes("hidden"));
    assert.ok(!text.includes("ns"));
    assert.ok(text.includes("Hello & welcome"));
    assert.ok(text.includes("It's 'here'"));
    const ls = text.split("\n");
    assert.ok(ls.includes("next"), "<br> becomes a line break");
    assert.ok(ls.includes("• One"));
    assert.ok(ls.includes("• Two"));
    assert.equal(ls[ls.length - 1], "tail");
    assert.ok(!text.includes("\n\n\n"), "no runs of blank lines");
    assert.equal(htmlToText("  <p>a</p>\n\n\n<p>b</p>  "), "a\nb");
  });

  test("decodeEntities handles named, decimal and hex forms", () => {
    assert.equal(decodeEntities("&lt;b&gt; &quot;q&quot; &nbsp;x &#128512; &unknown; &#x2019;"), '<b> "q"  x 😀 &unknown; ’');
    assert.equal(decodeEntities("&#99999999;"), "");
  });

  test("extractTitleTag", () => {
    assert.equal(extractTitleTag("<html><title>\n Hello &amp;\n World </title>"), "Hello & World");
    assert.equal(extractTitleTag("<p>x</p>"), null);
    assert.equal(extractTitleTag("<title>  </title>"), null);
  });

  test("extractMeta finds both attribute orders and either quote style", () => {
    assert.equal(extractMeta('<meta property="og:title" content="A &amp; B">', "og:title"), "A & B");
    assert.equal(extractMeta('<meta content="Desc here" name="description">', "description"), "Desc here");
    assert.equal(extractMeta("<meta name='description' content='single'>", "description"), "single");
    assert.equal(extractMeta('<meta name="other" content="no"><meta name="description" content="yes">', "description"), "yes");
    assert.equal(extractMeta('<meta name="description" content="">', "description"), null);
    assert.equal(extractMeta("<p>none</p>", "description"), null);
  });

  test("extractCanonical finds both attribute orders", () => {
    assert.equal(extractCanonical('<link rel="canonical" href="https://a.example/jobs/1">'), "https://a.example/jobs/1");
    assert.equal(extractCanonical('<link href="https://a.example/jobs/2" rel="canonical">'), "https://a.example/jobs/2");
    assert.equal(extractCanonical('<link rel="stylesheet" href="/x.css">'), null);
  });

  test("extractJsonLd parses multiple blocks, tolerates trailing commas, skips junk", () => {
    const html =
      '<script type="application/ld+json">{"@type":"JobPosting","title":"SE",}</script>' +
      "<script type='application/ld+json' data-x='1'>[1,2]</script>" +
      '<script type="application/ld+json">not json</script>' +
      '<script type="application/ld+json">   </script>' +
      '<script type="text/javascript">{"ignored":true}</script>';
    assert.deepEqual(extractJsonLd(html), [{ "@type": "JobPosting", title: "SE" }, [1, 2]]);
    assert.deepEqual(extractJsonLd("<p>none</p>"), []);
  });

  test("escapeHtml", () => {
    assert.equal(escapeHtml('<a href="x">O\'Neil & co</a>'), "&lt;a href=&quot;x&quot;&gt;O&#39;Neil &amp; co&lt;/a&gt;");
    assert.equal(escapeHtml("plain"), "plain");
  });
});

// ------------------------------------------------------------------- time

describe("time", () => {
  test("addDays crosses month and year boundaries in UTC", () => {
    assert.equal(addDays("2026-01-31T10:00:00.000Z", 1), "2026-02-01T10:00:00.000Z");
    assert.equal(addDays("2026-02-28T00:00:00.000Z", 1), "2026-03-01T00:00:00.000Z");
    assert.equal(addDays("2026-03-01T00:00:00.000Z", -1), "2026-02-28T00:00:00.000Z");
    assert.equal(addDays("2026-12-31T23:59:59.000Z", 1), "2027-01-01T23:59:59.000Z");
    assert.equal(addDays("2026-09-02T12:00:00.000Z", 0), "2026-09-02T12:00:00.000Z");
  });

  test("isoDate, isPastOrNow, nowIso", () => {
    assert.equal(isoDate("2026-09-01T10:00:00.000Z"), "2026-09-01");
    assert.equal(isoDate(null), "");
    assert.equal(isPastOrNow("2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"), true);
    assert.equal(isPastOrNow("2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z"), true);
    assert.equal(isPastOrNow("2026-09-03T00:00:00.000Z", "2026-09-02T00:00:00.000Z"), false);
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// -------------------------------------------------------------------- ids

describe("ids", () => {
  test("isValidId enforces the alphabet and 1-64 length", () => {
    assert.equal(isValidId("abc-DEF_123"), true);
    assert.equal(isValidId("a".repeat(64)), true);
    assert.equal(isValidId("a".repeat(65)), false);
    assert.equal(isValidId(""), false);
    assert.equal(isValidId("a/b"), false);
    assert.equal(isValidId("a b"), false);
    assert.equal(isValidId("é"), false);
    assert.equal(isValidId("../etc"), false);
  });

  test("newId produces distinct valid ids", () => {
    const a = newId();
    const b = newId();
    assert.notEqual(a, b);
    assert.equal(isValidId(a), true);
  });
});

// ------------------------------------------------------------------- hash

describe("hash", () => {
  test("sha256Hex known vectors", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("shortHash is the first 16 hex chars", () => {
    assert.equal(shortHash("abc"), "ba7816bf8f01cfea");
    assert.equal(shortHash("abc").length, 16);
  });
});
