/**
 * Adapter unit tests: Greenhouse (public Job Board API), RSS/Atom feeds, the
 * fixture-backed mock, and the registry. Every HTTP call goes through the
 * fake SafeFetcher from the harness, keyed by exact URL, so the tests prove
 * which URLs an adapter requests and never reach the network.
 *
 * Why: adapters are the only code that turns third-party payloads into
 * ManualOpportunityInput, so every produced item is re-validated against the
 * schema, and malformed entries must surface as warnings rather than crashes.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeFetcher } from "./helpers/harness.ts";
import type { AdapterContext, AtsAdapter } from "../src/adapters/types.ts";
import { GreenhouseAdapter } from "../src/adapters/greenhouse.ts";
import { RssAdapter, parseFeed, splitFeedTitle } from "../src/adapters/rss.ts";
import { MockAdapter } from "../src/adapters/mock.ts";
import { defaultAdapters, findAdapter } from "../src/adapters/registry.ts";
import { ManualOpportunityInputSchema, type ManualOpportunityInput } from "../src/schemas/opportunity.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
const NOW = "2026-09-01T10:00:00.000Z";
const ctx = (fetcher: AdapterContext["fetcher"]): AdapterContext => ({ fetcher, now: () => NOW });

function assertSchemaValid(items: ManualOpportunityInput[]): void {
  for (const item of items) {
    const parsed = ManualOpportunityInputSchema.safeParse(item);
    assert.ok(parsed.success, `${item.title}: ${parsed.success ? "" : parsed.error.message}`);
  }
}

describe("GreenhouseAdapter", () => {
  const BOARD_URL = "https://boards-api.greenhouse.io/v1/boards/northwindanalytics";
  const JOBS_URL = `${BOARD_URL}/jobs?content=true`;
  const boardFetcher = () =>
    fakeFetcher({
      [BOARD_URL]: { body: fixture("greenhouse-board.json"), contentType: "application/json" },
      [JOBS_URL]: { body: fixture("greenhouse-jobs.json"), contentType: "application/json" },
    });

  test("maps board jobs to OFFICIAL_ATS items and warns about the malformed job", async () => {
    const fetcher = boardFetcher();
    const result = await new GreenhouseAdapter().fetch("northwindanalytics", ctx(fetcher));
    assert.deepEqual(fetcher.calls, [BOARD_URL, JOBS_URL]);
    assert.equal(result.sourceName, "greenhouse:northwindanalytics");
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.warnings, ["Skipped a job with an unexpected shape."]);
    assertSchemaValid(result.items);

    const [first, second] = result.items;
    assert.ok(first && second);
    assert.equal(first.companyName, "Northwind Analytics");
    assert.equal(first.title, "Senior Software Engineer");
    assert.equal(first.sourceType, "OFFICIAL_ATS");
    assert.equal(first.sourceName, "greenhouse:northwindanalytics");
    assert.equal(first.externalId, "4010001");
    assert.equal(first.sourceUrl, "https://boards.greenhouse.io/northwindanalytics/jobs/4010001");
    assert.equal(first.applicationUrl, first.sourceUrl);
    assert.equal(first.canonicalUrl, first.sourceUrl);
    assert.equal(first.officialCareerUrl, "https://boards.greenhouse.io/northwindanalytics");
    assert.equal(first.locationText, "Remote - United States");
    assert.ok(first.postedAt);
    assert.equal(Date.parse(first.postedAt), Date.parse("2026-08-30T12:00:00-04:00"));

    // The API double-encodes HTML; the description must come out as entity-decoded plain text.
    assert.ok(first.rawDescription.includes("Fully remote & open to candidates"), first.rawDescription);
    assert.ok(!/<[a-z/][^>]*>/i.test(first.rawDescription), "description must not contain tags");
    assert.ok(!first.rawDescription.includes("&amp;"), "entities must be decoded");
    const bullets = first.rawDescription.split("\n").filter((l) => l.startsWith("• "));
    assert.ok(bullets.some((l) => l.includes("Design TypeScript services on Node.js")), bullets.join(" | "));

    assert.equal(second.title, "Data Analyst");
    assert.equal(second.externalId, "4010002");
    assert.equal(second.locationText, "Amsterdam, Netherlands");
    assert.equal(second.companyName, "Northwind Analytics");
  });

  test("lower-cases the board token before building URLs", async () => {
    const fetcher = boardFetcher();
    const result = await new GreenhouseAdapter().fetch("  NorthwindAnalytics ", ctx(fetcher));
    assert.deepEqual(fetcher.calls, [BOARD_URL, JOBS_URL]);
    assert.equal(result.items.length, 2);
  });

  test("falls back to the token as company name when the board has no name", async () => {
    const fetcher = fakeFetcher({
      [BOARD_URL]: { body: "{}", contentType: "application/json" },
      [JOBS_URL]: { body: fixture("greenhouse-jobs.json"), contentType: "application/json" },
    });
    const result = await new GreenhouseAdapter().fetch("northwindanalytics", ctx(fetcher));
    assert.equal(result.items[0]?.companyName, "northwindanalytics");
  });

  test("validateTarget rejects anything but a board token", () => {
    const gh = new GreenhouseAdapter();
    assert.equal(typeof gh.validateTarget("bad token!"), "string");
    assert.equal(typeof gh.validateTarget(""), "string");
    assert.equal(typeof gh.validateTarget("-leading-hyphen"), "string");
    assert.equal(typeof gh.validateTarget("a".repeat(65)), "string");
    assert.equal(gh.validateTarget("northwindanalytics"), null);
    assert.equal(gh.validateTarget("north_wind-2"), null);
  });

  test("a non-2xx board response throws with the status and stops before the jobs call", async () => {
    const fetcher = fakeFetcher({ [BOARD_URL]: { status: 503, body: "down", contentType: "application/json" } });
    await assert.rejects(new GreenhouseAdapter().fetch("northwindanalytics", ctx(fetcher)), /503/);
    assert.deepEqual(fetcher.calls, [BOARD_URL]);
  });

  test("a non-2xx jobs response throws with the status", async () => {
    const fetcher = fakeFetcher({
      [BOARD_URL]: { body: fixture("greenhouse-board.json"), contentType: "application/json" },
      [JOBS_URL]: { status: 404, body: "not found", contentType: "application/json" },
    });
    await assert.rejects(new GreenhouseAdapter().fetch("northwindanalytics", ctx(fetcher)), /404/);
  });

  test("an unexpected jobs payload throws", async () => {
    const fetcher = fakeFetcher({
      [BOARD_URL]: { body: fixture("greenhouse-board.json"), contentType: "application/json" },
      [JOBS_URL]: { body: '{"not":"jobs"}', contentType: "application/json" },
    });
    await assert.rejects(new GreenhouseAdapter().fetch("northwindanalytics", ctx(fetcher)), /unexpected payload/);
  });
});

describe("RssAdapter", () => {
  const RSS_URL = "https://jobs.example.org/feed.xml";
  const ATOM_URL = "https://atom.example.org/feed.atom";
  const feedFetcher = () =>
    fakeFetcher({
      [RSS_URL]: { body: fixture("feed-rss.xml"), contentType: "application/rss+xml" },
      [ATOM_URL]: { body: fixture("feed-atom.xml"), contentType: "application/atom+xml" },
    });

  test("parseFeed reads RSS 2.0 items, CDATA bodies and the channel title", () => {
    const feed = parseFeed(fixture("feed-rss.xml"));
    assert.equal(feed.title, "Example Remote Jobs");
    assert.equal(feed.items.length, 3);
    const [a, b, c] = feed.items;
    assert.ok(a && b && c);
    assert.equal(a.title, "Technical Writer at Fabrikam Docs");
    assert.equal(a.link, "https://jobs.example.org/posts/101");
    assert.equal(a.id, "post-101");
    assert.equal(a.published, "Mon, 31 Aug 2026 10:00:00 GMT");
    assert.ok(a.content.startsWith("<p>Remote (worldwide). Write API documentation & guides.</p>"), a.content);
    assert.ok(b.content.includes("Own renewals"), "content:encoded is preferred");
    assert.equal(c.link, null);
  });

  test("fetch maps RSS items to schema-valid RSS opportunities and warns about the linkless item", async () => {
    const fetcher = feedFetcher();
    const result = await new RssAdapter().fetch(RSS_URL, ctx(fetcher));
    assert.deepEqual(fetcher.calls, [RSS_URL]);
    assert.equal(result.sourceName, "rss:jobs.example.org");
    assert.equal(result.items.length, 2);
    assert.equal(result.warnings.length, 1);
    assert.ok(/without a link or title/.test(result.warnings[0] ?? ""), result.warnings[0]);
    assertSchemaValid(result.items);

    const [first, second] = result.items;
    assert.ok(first && second);
    assert.equal(first.title, "Technical Writer");
    assert.equal(first.companyName, "Fabrikam Docs");
    assert.equal(first.sourceType, "RSS");
    assert.equal(first.sourceName, "rss:jobs.example.org");
    assert.equal(first.externalId, "post-101");
    assert.equal(first.sourceUrl, "https://jobs.example.org/posts/101");
    assert.equal(first.applicationUrl, first.sourceUrl);
    assert.ok(!/<[a-z/][^>]*>/i.test(first.rawDescription), "description must be plain text");
    assert.ok(first.rawDescription.includes("Write API documentation & guides."), first.rawDescription);
    assert.ok(first.rawDescription.includes("• 3+ years technical writing"), first.rawDescription);
    assert.ok(first.postedAt);
    assert.equal(Date.parse(first.postedAt), Date.parse("2026-08-31T10:00:00Z"));

    assert.equal(second.title, "Customer Success Manager");
    assert.equal(second.companyName, "Contoso Freight");
    assert.equal(second.externalId, "post-102");
    assert.equal(second.rawDescription, "Hybrid in Austin, TX. Own renewals for mid-market accounts.");
  });

  test("fetch reads Atom entries, taking links from href", async () => {
    const fetcher = feedFetcher();
    const result = await new RssAdapter().fetch(ATOM_URL, ctx(fetcher));
    assert.equal(result.sourceName, "rss:atom.example.org");
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.warnings, []);
    assertSchemaValid(result.items);

    const [ux, acct] = result.items;
    assert.ok(ux && acct);
    // "UX Designer - Northwind Analytics": "designer" is a role word, so the left side is the title.
    assert.equal(ux.title, "UX Designer");
    assert.equal(ux.companyName, "Northwind Analytics");
    assert.equal(ux.sourceUrl, "https://atom.example.org/jobs/201");
    assert.equal(ux.externalId, "urn:job:201");
    assert.ok(ux.postedAt);
    assert.equal(Date.parse(ux.postedAt), Date.parse("2026-08-29T08:00:00Z"));
    assert.equal(ux.rawDescription, "Remote in the EU. Figma, design systems, UX research.");
    // "Fabrikam Payments - Accountant": the right side is a known role title, so it becomes the title.
    assert.equal(acct.title, "Accountant");
    assert.equal(acct.companyName, "Fabrikam Payments");
    assert.equal(acct.sourceUrl, "https://atom.example.org/jobs/202");
    assert.equal(acct.externalId, "urn:job:202");
    assert.equal(acct.rawDescription, "On-site in Denver, CO. QuickBooks and GAAP required.");
  });

  test("uses the feed title as company when the item title has no company", async () => {
    const xml = fixture("feed-rss.xml").replace("Technical Writer at Fabrikam Docs", "Technical Writer");
    const fetcher = fakeFetcher({ [RSS_URL]: { body: xml, contentType: "application/rss+xml" } });
    const result = await new RssAdapter().fetch(RSS_URL, ctx(fetcher));
    assert.equal(result.items[0]?.companyName, "Example Remote Jobs");
  });

  test("splitFeedTitle handles the common title shapes", () => {
    const table: [string, { title: string; company: string | null }][] = [
      ["Technical Writer at Fabrikam Docs", { title: "Technical Writer", company: "Fabrikam Docs" }],
      ["Contoso Freight: Customer Success Manager", { title: "Customer Success Manager", company: "Contoso Freight" }],
      ["UX Designer - Northwind Analytics", { title: "UX Designer", company: "Northwind Analytics" }],
      ["Northwind Analytics - UX Designer", { title: "UX Designer", company: "Northwind Analytics" }],
      ["Northwind Analytics | Backend Engineer", { title: "Backend Engineer", company: "Northwind Analytics" }],
      ["Backend  Engineer   at   Northwind Analytics ", { title: "Backend Engineer", company: "Northwind Analytics" }],
      ["Fabrikam Payments - Accountant", { title: "Accountant", company: "Fabrikam Payments" }],
      ["Staff Software Engineer", { title: "Staff Software Engineer", company: null }],
    ];
    for (const [input, expected] of table) assert.deepEqual(splitFeedTitle(input), expected, input);
  });

  test("validateTarget accepts only http(s) URLs", () => {
    const rss = new RssAdapter();
    assert.equal(typeof rss.validateTarget("ftp://x"), "string");
    assert.equal(typeof rss.validateTarget("not a url"), "string");
    assert.equal(rss.validateTarget("https://jobs.example.org/feed.xml"), null);
    assert.equal(rss.validateTarget("http://jobs.example.org/feed.xml"), null);
  });

  test("a non-2xx response throws with the status", async () => {
    const fetcher = fakeFetcher({ [RSS_URL]: { status: 403, body: "", contentType: "text/plain" } });
    await assert.rejects(new RssAdapter().fetch(RSS_URL, ctx(fetcher)), /403/);
  });
});

describe("MockAdapter", () => {
  // Typed through the interface: the mock ignores the context, but callers hand it one.
  const mock: AtsAdapter = new MockAdapter();

  test('"sample" returns three synthetic listings including the scam sample', async () => {
    const result = await mock.fetch("sample", ctx(fakeFetcher({})));
    assert.equal(result.sourceName, "mock:sample");
    assert.equal(result.items.length, 3);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.items.some((i) => i.title.includes("Data Entry")));
    assertSchemaValid(result.items);
  });

  test('"empty" returns no items', async () => {
    const result = await mock.fetch("empty", ctx(fakeFetcher({})));
    assert.equal(result.sourceName, "mock:empty");
    assert.deepEqual(result.items, []);
  });

  test("rejects unknown targets both in validateTarget and fetch", async () => {
    assert.equal(typeof mock.validateTarget("nope"), "string");
    assert.equal(mock.validateTarget("sample"), null);
    await assert.rejects(mock.fetch("nope", ctx(fakeFetcher({}))), /sample.*empty/);
  });

  test("returns fresh item objects on every call", async () => {
    const a = await mock.fetch("sample", ctx(fakeFetcher({})));
    const b = await mock.fetch("sample", ctx(fakeFetcher({})));
    assert.deepEqual(a.items, b.items);
    assert.notEqual(a.items[0], b.items[0]);
  });
});

describe("registry", () => {
  test("defaultAdapters exposes greenhouse, rss and mock in that order", () => {
    const adapters = defaultAdapters();
    assert.deepEqual(adapters.map((a) => a.id), ["greenhouse", "rss", "mock"]);
    for (const a of adapters) {
      assert.ok(a.displayName.length > 0);
      assert.ok(a.policyNote.length > 0);
      assert.ok(a.targetHint.length > 0);
    }
  });

  test("findAdapter returns the adapter by id or null", () => {
    const adapters = defaultAdapters();
    assert.equal(findAdapter(adapters, "rss")?.id, "rss");
    assert.equal(findAdapter(adapters, "unknown"), null);
    assert.equal(findAdapter([], "mock"), null);
  });
});
