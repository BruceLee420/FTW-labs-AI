/**
 * SSRF guard: IP parsing and reserved-range checks, the host denylist, URL
 * validation, DNS resolution, robots.txt evaluation and the safe fetcher.
 * Everything runs against injected fetch/lookup fakes — no network.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress, parseIp } from "../src/security/ipRanges.ts";
import { denylistReason } from "../src/security/denylist.ts";
import { createSafeFetcher, resolveSafely, ROBOTS_AGENT, USER_AGENT, validateTargetUrl, type LookupFn } from "../src/security/ssrf.ts";
import { parseRobots } from "../src/security/robots.ts";
import { FetchPolicyError, UnsafeUrlError, type SafeFetchOptions } from "../src/security/fetchTypes.ts";

// ---------------------------------------------------------------- helpers

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A `fetch` stand-in that records every call and dispatches to `handler`. */
function fakeFetch(handler: Handler): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const zeros = (n: number): number[] => Array<number>(n).fill(0);
const page = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const notFound = (): Response => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
const redirectTo = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });
const headerOf = (call: FetchCall | undefined, name: string): string | undefined => (call?.init?.headers as Record<string, string> | undefined)?.[name];

const baseConfig = { fetchMaxBytes: 1_000_000, fetchMaxRedirects: 3, fetchTimeoutMs: 5_000, urlDenylist: [] as string[] };

function fetcherWith(handler: Handler, overrides: Partial<typeof baseConfig> = {}, lookup: LookupFn = publicLookup) {
  const fetchImpl = fakeFetch(handler);
  const fetcher = createSafeFetcher({ ...baseConfig, ...overrides }, { fetchImpl, lookup });
  return { fetcher, fetchImpl };
}

/** Never resolves on its own; rejects once the request signal aborts (like real fetch). */
const hanging: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

// ---------------------------------------------------------------- parseIp

describe("parseIp", () => {
  test("accepts canonical dotted-quad IPv4 (trimmed)", () => {
    assert.deepEqual(parseIp("93.184.216.34"), { version: 4, bytes: [93, 184, 216, 34] });
    assert.deepEqual(parseIp(" 8.8.8.8 "), { version: 4, bytes: [8, 8, 8, 8] });
    assert.deepEqual(parseIp("0.0.0.0"), { version: 4, bytes: [0, 0, 0, 0] });
  });

  test("rejects shorthand, hex, decimal and malformed IPv4 spellings", () => {
    for (const s of ["127.1", "0x7f000001", "2130706433", "127.0.0.1.1", "256.1.1.1", "01.2.3.4", "", "example.com", "1.2.3"]) {
      assert.equal(parseIp(s), null, `expected null for ${JSON.stringify(s)}`);
    }
  });

  test("parses IPv6 forms including zone ids and brackets", () => {
    assert.deepEqual(parseIp("::1"), { version: 6, bytes: [...zeros(15), 1] });
    assert.deepEqual(parseIp("::"), { version: 6, bytes: zeros(16) });
    assert.deepEqual(parseIp("fe80::1%eth0"), { version: 6, bytes: [0xfe, 0x80, ...zeros(13), 1] });
    const bracketed = parseIp("[::ffff:127.0.0.1]");
    assert.equal(bracketed?.version, 6);
    assert.deepEqual(bracketed?.bytes.slice(12), [127, 0, 0, 1]);
    assert.deepEqual(parseIp("2001:db8::1"), { version: 6, bytes: [0x20, 0x01, 0x0d, 0xb8, ...zeros(11), 1] });
  });

  test("::ffff:127.0.0.1 is version 6 carrying the embedded IPv4 bytes", () => {
    const p = parseIp("::ffff:127.0.0.1");
    assert.equal(p?.version, 6);
    assert.deepEqual(p?.bytes, [...zeros(10), 0xff, 0xff, 127, 0, 0, 1]);
  });

  test("rejects malformed IPv6", () => {
    for (const s of ["1::2::3", "12345::1", "::ffff:999.1.1.1", "g::1", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9"]) {
      assert.equal(parseIp(s), null, `expected null for ${s}`);
    }
  });
});

// ---------------------------------------------------------- isBlockedAddress

describe("isBlockedAddress", () => {
  test("one representative from every blocked IPv4 range", () => {
    const blocked = [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  });

  test("public addresses are not blocked", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "93.184.216.34", "2606:4700::1111", "2001:4860:4860::8888"]) {
      assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
    }
  });

  test("blocked IPv6 ranges, including mapped/translated IPv4", () => {
    for (const ip of ["::", "::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fd12::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "100::1"]) {
      assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
    }
    // Mapped public IPv4 stays allowed.
    assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
  });

  test("unparseable input counts as blocked", () => {
    for (const s of ["garbage", "127.1", "0x7f000001", "", "example.com"]) assert.equal(isBlockedAddress(s), true, s);
  });
});

// ---------------------------------------------------------- denylistReason

describe("denylistReason", () => {
  test("built-in platforms match the apex and every subdomain", () => {
    for (const host of ["linkedin.com", "www.linkedin.com", "jobs.linkedin.com", "indeed.com", "LinkedIn.com."]) {
      assert.match(denylistReason(host) ?? "", /prohibits automated access/, host);
    }
  });

  test("look-alike hosts are not matched unless listed", () => {
    assert.equal(denylistReason("glassdoor.co"), null);
    assert.equal(denylistReason("notlinkedin.com"), null);
    assert.equal(denylistReason("linkedin.com.evil.example"), null);
  });

  test("custom entries match the domain and its subdomains", () => {
    assert.match(denylistReason("jobs.example.org", ["Example.org"]) ?? "", /example\.org is on your denylist/);
    assert.match(denylistReason("example.org", [" example.org "]) ?? "", /OPPORTUNITY_RADAR_URL_DENYLIST/);
    assert.equal(denylistReason("example.org", ["other.org", ""]), null);
  });

  test("unrelated hosts → null", () => {
    assert.equal(denylistReason("boards.greenhouse.io"), null);
    assert.equal(denylistReason("example.com"), null);
  });
});

// ------------------------------------------------------- validateTargetUrl

describe("validateTargetUrl", () => {
  test("rejects non-http schemes with UnsafeUrlError", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,hi"]) {
      assert.throws(() => validateTargetUrl(u), UnsafeUrlError, u);
    }
  });

  test("rejects credentials, local names and single-label hosts", () => {
    assert.throws(() => validateTargetUrl("http://user:pass@example.com"), UnsafeUrlError);
    assert.throws(() => validateTargetUrl("http://localhost"), UnsafeUrlError);
    assert.throws(() => validateTargetUrl("http://foo.localhost"), UnsafeUrlError);
    assert.throws(() => validateTargetUrl("http://intranet"), UnsafeUrlError);
    assert.throws(() => validateTargetUrl("http://box.internal/x"), UnsafeUrlError);
  });

  test("rejects private and reserved addresses in every spelling", () => {
    for (const u of ["http://127.0.0.1", "http://[::1]/", "http://169.254.169.254/latest", "http://10.0.0.1", "http://0x7f000001", "http://2130706433"]) {
      assert.throws(() => validateTargetUrl(u), UnsafeUrlError, u);
    }
  });

  test("denylisted hosts raise FetchPolicyError (not UnsafeUrlError)", () => {
    assert.throws(() => validateTargetUrl("https://linkedin.com/jobs/1"), FetchPolicyError);
    assert.throws(() => validateTargetUrl("https://linkedin.com/jobs/1"), (err: unknown) => !(err instanceof UnsafeUrlError));
    assert.throws(() => validateTargetUrl("https://jobs.example.org/x", { denylist: ["example.org"] }), FetchPolicyError);
  });

  test("rejects over-long and unparseable input", () => {
    assert.throws(() => validateTargetUrl("https://example.com/" + "a".repeat(3000)), UnsafeUrlError);
    assert.throws(() => validateTargetUrl("not a url"), UnsafeUrlError);
    assert.throws(() => validateTargetUrl("http://example.com:0/"), UnsafeUrlError);
  });

  test("accepts ordinary public URLs and returns the parsed URL", () => {
    assert.equal(validateTargetUrl("https://boards.greenhouse.io/x").toString(), "https://boards.greenhouse.io/x");
    const u = validateTargetUrl("https://example.com:8443/jobs");
    assert.equal(u.port, "8443");
    assert.equal(u.hostname, "example.com");
  });

  test("errors carry a user-facing reason", () => {
    try {
      validateTargetUrl("http://127.0.0.1");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof UnsafeUrlError);
      assert.equal(err.name, "UnsafeUrlError");
      assert.match(err.reason, /private or reserved/);
    }
  });
});

// ----------------------------------------------------------- resolveSafely

describe("resolveSafely", () => {
  test("returns addresses when every record is public", async () => {
    assert.deepEqual(await resolveSafely("example.com", publicLookup), ["93.184.216.34"]);
  });

  test("a private address alongside a public one is rejected", async () => {
    const lookup: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await assert.rejects(resolveSafely("example.com", lookup), UnsafeUrlError);
  });

  test("empty answers and lookup failures both throw UnsafeUrlError", async () => {
    await assert.rejects(resolveSafely("example.com", async () => []), UnsafeUrlError);
    await assert.rejects(
      resolveSafely("example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
      UnsafeUrlError,
    );
  });

  test("IP literals skip DNS entirely", async () => {
    let called = false;
    const lookup: LookupFn = async () => {
      called = true;
      return [];
    };
    assert.deepEqual(await resolveSafely("93.184.216.34", lookup), ["93.184.216.34"]);
    assert.equal(called, false);
    await assert.rejects(resolveSafely("[::1]", lookup), UnsafeUrlError);
  });
});

// ------------------------------------------------------------- parseRobots

describe("parseRobots", () => {
  test("empty file allows everything", () => {
    assert.equal(parseRobots("").isAllowed("/anything"), true);
    assert.equal(parseRobots("").isAllowed("/", ROBOTS_AGENT), true);
  });

  test("Disallow prefix blocks matching paths only", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private");
    assert.equal(r.isAllowed("/private/x"), false);
    assert.equal(r.isAllowed("/private"), false);
    assert.equal(r.isAllowed("/public"), true);
  });

  test("longest match wins: Allow beats a shorter Disallow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /jobs\nAllow: /jobs/public");
    assert.equal(r.isAllowed("/jobs/public/1"), true);
    assert.equal(r.isAllowed("/jobs/secret"), false);
  });

  test("$ anchors the pattern end and * is a wildcard", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$");
    assert.equal(r.isAllowed("/a.pdf"), false);
    assert.equal(r.isAllowed("/docs/a.pdf"), false);
    assert.equal(r.isAllowed("/a.pdf?x=1"), true);
    assert.equal(r.isAllowed("/a.pdfx"), true);
  });

  test("a group for our agent overrides the * group", () => {
    const r = parseRobots("User-agent: FTWOpportunityRadar\nDisallow: /\n\nUser-agent: *\nAllow: /");
    assert.equal(r.isAllowed("/jobs/1", ROBOTS_AGENT), false);
    assert.equal(r.isAllowed("/jobs/1", "FTWOpportunityRadar/0.1 (+https://ftwlabs.ai)"), false);
    assert.equal(r.isAllowed("/jobs/1"), true);
    assert.equal(r.isAllowed("/jobs/1", "Googlebot"), true);
  });

  test("comments and blank Disallow lines are ignored", () => {
    const r = parseRobots("# top comment\nUser-agent: *\nDisallow:\nDisallow: /x # trailing comment\nCrawl-delay: 10\nSitemap: https://a.example/sitemap.xml");
    assert.equal(r.isAllowed("/x/1"), false);
    assert.equal(r.isAllowed("/y"), true);
  });

  test("consecutive User-agent lines share one group; agents are case-insensitive", () => {
    const r = parseRobots("User-agent: Foo\nUser-agent: ftwopportunityradar\nDisallow: /a\n\nUser-agent: *\nDisallow: /b");
    assert.equal(r.isAllowed("/a", ROBOTS_AGENT), false);
    assert.equal(r.isAllowed("/b", ROBOTS_AGENT), true);
    assert.equal(r.isAllowed("/b"), false);
  });
});

// ------------------------------------------------------- createSafeFetcher

describe("createSafeFetcher", () => {
  test("follows a redirect to another public host and records the hops", async () => {
    const { fetcher, fetchImpl } = fetcherWith((url) => {
      if (url === "https://a.example/start") return redirectTo("https://b.example/final");
      if (url === "https://b.example/final") return page("<p>done</p>");
      return notFound();
    });
    const res = await fetcher("https://a.example/start");
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, "https://b.example/final");
    assert.deepEqual(res.redirects, ["https://b.example/final"]);
    assert.equal(res.body, "<p>done</p>");
    assert.equal(res.contentType, "text/html; charset=utf-8");
    assert.equal(res.truncated, false);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    const pageCalls = fetchImpl.calls.filter((c) => !c.url.endsWith("/robots.txt")).map((c) => c.url);
    assert.deepEqual(pageCalls, ["https://a.example/start", "https://b.example/final"]);
    assert.ok(fetchImpl.calls.every((c) => c.init?.redirect === "manual"), "redirects must be handled manually");
  });

  test("resolves relative Location headers against the current URL", async () => {
    const { fetcher } = fetcherWith((url) => {
      if (url === "https://a.example/start") return redirectTo("/next?x=1", 301);
      if (url === "https://a.example/next?x=1") return page("ok");
      return notFound();
    });
    const res = await fetcher("https://a.example/start");
    assert.equal(res.finalUrl, "https://a.example/next?x=1");
    assert.deepEqual(res.redirects, ["https://a.example/next?x=1"]);
  });

  test("blocks a redirect to a private address", async () => {
    const { fetcher, fetchImpl } = fetcherWith((url) => {
      if (url === "https://a.example/start") return redirectTo("http://127.0.0.1/admin");
      return notFound();
    });
    await assert.rejects(fetcher("https://a.example/start"), UnsafeUrlError);
    assert.ok(!fetchImpl.calls.some((c) => c.url.startsWith("http://127.0.0.1")), "must never contact the private address");
  });

  test("a redirect to a denylisted host is a FetchPolicyError", async () => {
    const { fetcher } = fetcherWith((url) => (url === "https://a.example/start" ? redirectTo("https://www.linkedin.com/jobs/1") : notFound()));
    await assert.rejects(fetcher("https://a.example/start"), FetchPolicyError);
  });

  test("stops after maxRedirects with 'Too many redirects'", async () => {
    let n = 0;
    const { fetcher, fetchImpl } = fetcherWith((url) => (url.endsWith("/robots.txt") ? notFound() : redirectTo(`https://a.example/hop${++n}`)), { fetchMaxRedirects: 2 });
    await assert.rejects(fetcher("https://a.example/start"), (err: unknown) => err instanceof FetchPolicyError && /Too many redirects/.test(err.message));
    assert.equal(fetchImpl.calls.filter((c) => !c.url.endsWith("/robots.txt")).length, 3);
  });

  test("a redirect without Location is a FetchPolicyError", async () => {
    const { fetcher } = fetcherWith((url) => (url.endsWith("/robots.txt") ? notFound() : new Response(null, { status: 302 })));
    await assert.rejects(fetcher("https://a.example/x"), (err: unknown) => err instanceof FetchPolicyError && /without a destination/.test(err.message));
  });

  test("truncates a 5 MB body at fetchMaxBytes", async () => {
    const { fetcher } = fetcherWith((url) => (url.endsWith("/robots.txt") ? notFound() : page("x".repeat(5_000_000))), { fetchMaxBytes: 1_000_000 });
    const res = await fetcher("https://a.example/big");
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.equal(res.body.length, 1_000_000);
    const small = await fetcher("https://a.example/big", { maxBytes: 10 });
    assert.equal(small.body, "xxxxxxxxxx");
    assert.equal(small.truncated, true);
  });

  test("times out when the server never answers", async () => {
    const { fetcher } = fetcherWith(hanging, { fetchTimeoutMs: 30 });
    await assert.rejects(fetcher("https://a.example/slow", { skipRobots: true }), (err: unknown) => err instanceof FetchPolicyError && /too long/.test(err.message));
  });

  test("a network failure is a FetchPolicyError, not a crash", async () => {
    const { fetcher } = fetcherWith(async (url) => {
      if (url.endsWith("/robots.txt")) return notFound();
      throw new TypeError("fetch failed");
    });
    await assert.rejects(fetcher("https://a.example/x"), (err: unknown) => err instanceof FetchPolicyError && /could not be reached/.test(err.message));
  });

  test("honours robots.txt Disallow and caches robots per origin", async () => {
    const { fetcher, fetchImpl } = fetcherWith((url) => {
      if (url === "https://a.example/robots.txt") return new Response("User-agent: *\nDisallow: /private", { status: 200, headers: { "content-type": "text/plain" } });
      if (url === "https://b.example/robots.txt") return notFound();
      return page("ok");
    });
    const robotsCalls = () => fetchImpl.calls.filter((c) => c.url.endsWith("/robots.txt")).map((c) => c.url);

    assert.equal((await fetcher("https://a.example/public")).ok, true);
    assert.equal((await fetcher("https://a.example/public2")).ok, true);
    assert.deepEqual(robotsCalls(), ["https://a.example/robots.txt"], "robots.txt fetched once per origin");

    await assert.rejects(fetcher("https://a.example/private/1"), (err: unknown) => err instanceof FetchPolicyError && /robots\.txt/.test(err.message));
    assert.ok(!fetchImpl.calls.some((c) => c.url === "https://a.example/private/1"), "disallowed page must not be requested");

    assert.equal((await fetcher("https://b.example/private/1")).ok, true);
    assert.deepEqual(robotsCalls(), ["https://a.example/robots.txt", "https://b.example/robots.txt"]);
    assert.equal(headerOf(fetchImpl.calls[0], "User-Agent"), USER_AGENT, "robots fetch identifies itself");
  });

  test("skipRobots avoids the robots.txt request", async () => {
    const { fetcher, fetchImpl } = fetcherWith(() => page("ok"));
    const res = await fetcher("https://a.example/x", { skipRobots: true });
    assert.equal(res.ok, true);
    assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith("/robots.txt")).length, 0);
    assert.deepEqual(
      fetchImpl.calls.map((c) => c.url),
      ["https://a.example/x"],
    );
  });

  test("marks 403 responses and challenge pages as access-blocked", async () => {
    const { fetcher } = fetcherWith((url) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url.endsWith("/forbidden")) return page("Forbidden", 403);
      if (url.endsWith("/challenge")) return page("<div id='cf-chl-widget'>Checking your browser</div>");
      return page("<h1>Job</h1>");
    });
    const forbidden = await fetcher("https://a.example/forbidden");
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers["x-radar-access-block"], "login-or-captcha");
    const challenge = await fetcher("https://a.example/challenge");
    assert.equal(challenge.status, 200);
    assert.equal(challenge.headers["x-radar-access-block"], "login-or-captcha");
    const normal = await fetcher("https://a.example/job");
    assert.equal(normal.headers["x-radar-access-block"], undefined);
  });

  test("rejects unexpected content types when acceptContentTypes is given", async () => {
    const { fetcher } = fetcherWith((url) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url.endsWith("/file.pdf")) return page("%PDF-1.4", 200, { "content-type": "application/pdf" });
      return page("<p>ok</p>", 200, { "content-type": "Text/HTML; charset=UTF-8" });
    });
    await assert.rejects(fetcher("https://a.example/file.pdf", { acceptContentTypes: ["text/html"] }), (err: unknown) => err instanceof FetchPolicyError && /Unexpected content type \(application\/pdf\)/.test(err.message));
    const ok = await fetcher("https://a.example/page", { acceptContentTypes: ["text/html", "application/json"] });
    assert.equal(ok.ok, true);
    // Without the option any type is returned.
    assert.equal((await fetcher("https://a.example/file.pdf")).contentType, "application/pdf");
  });

  test("only GET and HEAD are permitted", async () => {
    const { fetcher, fetchImpl } = fetcherWith(() => page("ok"));
    await assert.rejects(fetcher("https://a.example/x", { method: "POST" } as unknown as SafeFetchOptions), (err: unknown) => err instanceof FetchPolicyError && /Only GET and HEAD/.test(err.message));
    assert.equal(fetchImpl.calls.length, 0);
    const head = await fetcher("https://a.example/x", { method: "HEAD", skipRobots: true });
    assert.equal(head.ok, true);
    assert.equal(head.body, "");
    assert.equal(fetchImpl.calls[0]?.init?.method, "HEAD");
  });

  test("sends the FTWOpportunityRadar User-Agent (overridable) and merges extra headers", async () => {
    const { fetcher, fetchImpl } = fetcherWith(() => page("ok"));
    await fetcher("https://a.example/x", { skipRobots: true, headers: { "X-Extra": "1" } });
    const call = fetchImpl.calls[0];
    assert.equal(call?.url, "https://a.example/x");
    assert.equal(call?.init?.method, "GET");
    assert.match(headerOf(call, "User-Agent") ?? "", /FTWOpportunityRadar/);
    assert.equal(headerOf(call, "X-Extra"), "1");
    assert.match(USER_AGENT, /^FTWOpportunityRadar\//);

    const custom = fakeFetch(() => page("ok"));
    const customFetcher = createSafeFetcher(baseConfig, { fetchImpl: custom, lookup: publicLookup, userAgent: "TestAgent/1.0" });
    await customFetcher("https://a.example/y", { skipRobots: true });
    assert.equal(headerOf(custom.calls[0], "User-Agent"), "TestAgent/1.0");
  });

  test("a 404 is returned with ok:false rather than thrown", async () => {
    const { fetcher } = fetcherWith(() => notFound());
    const res = await fetcher("https://a.example/missing");
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(res.body, "nope");
    assert.deepEqual(res.redirects, []);
  });

  test("config denylist and private DNS answers stop the request before any fetch", async () => {
    const denied = fetcherWith(() => page("ok"), { urlDenylist: ["blocked.example"] });
    await assert.rejects(denied.fetcher("https://jobs.blocked.example/x"), FetchPolicyError);
    assert.equal(denied.fetchImpl.calls.length, 0);

    const rebinding = fetcherWith(() => page("ok"), {}, async () => [{ address: "169.254.169.254", family: 4 }]);
    await assert.rejects(rebinding.fetcher("https://a.example/x"), UnsafeUrlError);
    assert.equal(rebinding.fetchImpl.calls.length, 0);
  });
});
