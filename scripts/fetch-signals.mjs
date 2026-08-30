#!/usr/bin/env node
/**
 * FTW Labs AI — daily signal fetcher.
 *
 * Runs from GitHub Actions on a cron. Pulls what it can from official,
 * terms-compliant sources, scores it for print-on-demand usefulness, and
 * writes a dated JSON snapshot the static site reads.
 *
 * Design rules (same discipline as the rest of this project):
 *   - No scraping. Only official APIs, public first-party feeds, and
 *     credentials the operator supplies.
 *   - Runs with ZERO secrets. Google Trends RSS needs no auth, so the
 *     pipeline always produces something. Other sources light up as their
 *     secrets appear in the environment.
 *   - One source failing never kills the run.
 *   - Every number carries its source and a confidence level. Nothing is
 *     presented as market truth when it is an inference.
 *
 * Zero npm dependencies — Node 20+ built-ins only.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "data", "signals");
const HISTORY_FILE = path.join(OUT_DIR, "history.json");
const LATEST_FILE = path.join(OUT_DIR, "latest.json");
const HISTORY_DAYS = 120;

const GEOS = (process.env.TRENDS_GEOS || "US,GB,CA,AU").split(",").map((g) => g.trim()).filter(Boolean);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const PRINTFUL_TOKEN = process.env.PRINTFUL_TOKEN || "";
// Etsy expects the COMBINED form "keystring:sharedsecret" in x-api-key.
// Verified against the live API — the published docs still describe a
// keystring-only header, which the API rejects with 403.
const ETSY_API_KEY = process.env.ETSY_API_KEY || "";

const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Tiny XML helpers. The Trends feed is a small, well-formed, first-party RSS
// document with a known shape (verified against the live feed), so targeted
// extraction is adequate here and avoids pulling in a parser dependency.
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .trim();
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]) : "";
}

function allBlocks(xml, tag) {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g")) || [];
}

/** "5000+" -> 5000, "500+" -> 500, "" -> 0 */
function parseTraffic(raw) {
  const n = Number(String(raw).replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Classification — the part that actually matters.
//
// Raw trending searches are dominated by sport, politics and celebrity news.
// Most of it is either unsellable or actively dangerous to print (league
// marks, personal likeness). These heuristics separate the rare usable signal
// from the noise, and loudly flag the legal traps.
//
// These are HEURISTICS, not legal advice — the output labels them as such.
// ---------------------------------------------------------------------------

/** Domains that reliably indicate a trademark-heavy topic. */
const RISKY_DOMAINS = [
  "mlb.com", "nfl.com", "nba.com", "nhl.com", "espn.com", "fifa.com", "uefa.com",
  "masnsports.com", "bleacherreport.com", "skysports.com", "premierleague.com",
  "ncaa.com", "formula1.com", "wwe.com", "ufc.com", "olympics.com",
  "marvel.com", "dc.com", "disney.com", "nintendo.com", "playstation.com",
  "netflix.com", "hbo.com", "ticketmaster.com", "livenation.com",
];

/** Topic words implying protected marks, likeness, or event IP. */
const RISKY_TERMS = [
  "vs", "game", "score", "match", "fixture", "lineup", "playoff", "season",
  "concert", "tour", "album", "movie", "trailer", "episode", "season finale",
  "super bowl", "world cup", "olympics", "grammy", "oscar", "premiere",
  "fc", "united", "city", "lakers", "yankees", "orioles", "cowboys",
  // League and competition abbreviations — these are themselves marks, and a
  // topic carrying one is essentially never safe to print.
  "afl", "nrl", "nba", "nfl", "mlb", "nhl", "epl", "ufc", "wwe", "ncaa",
  "f1", "formula 1", "premier league", "champions league", "open", "cup",
  "fifa", "uefa", "test match", "grand slam", "bulldogs", "magpies",
];

/** News/politics/finance domains — real news, but not merch material. */
const NEWS_DOMAINS = [
  "cnn.com", "bbc.co.uk", "bbc.com", "reuters.com", "apnews.com", "nytimes.com",
  "washingtonpost.com", "politico.com", "foxnews.com", "nbcnews.com", "cnbc.com",
  "theguardian.com", "aljazeera.com", "bloomberg.com", "wsj.com", "usatoday.com",
];

const NEWS_TERMS = [
  "election", "senate", "congress", "lawsuit", "court", "trial", "indicted",
  "shooting", "crash", "storm", "hurricane", "earthquake", "war", "strike",
  "tariff", "inflation", "stock", "earnings", "verdict", "arrested", "died",
  "death", "obituary", "capital punishment", "weather", "météo", "forecast",
];

/** Aesthetic / craft / lifestyle vocabulary — genuinely printable territory. */
const POD_TERMS = [
  "aesthetic", "cottagecore", "goblincore", "dark academia", "cozy", "vintage",
  "retro", "botanical", "mushroom", "celestial", "tarot", "astrology", "moon",
  "plant", "cat", "dog", "coffee", "tea", "book", "reading", "knitting", "craft",
  "camping", "hiking", "van life", "surf", "mountain", "forest", "ocean",
  "halloween", "christmas", "valentine", "spooky", "pumpkin", "witch", "ghost",
  "gamer", "anime", "kawaii", "pastel", "minimalist", "line art", "typography",
  "motivational", "funny", "sarcastic", "mom", "dad", "teacher", "nurse",
];

/**
 * Whole-word match. Critically NOT `includes()` — substring matching produced
 * real false negatives on live data ("dog" matching inside "bulldogs" cleared
 * an AFL fixture as safe to print; "tea" inside "teachers" cleared a political
 * lawsuit). A false "safe" here is a trademark exposure, so this errs strict.
 */
function hasTerm(haystack, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

function classify(item) {
  const title = item.title.toLowerCase();
  const domains = item.newsItems.map((n) => {
    try {
      return new URL(n.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  });
  const headlineText = item.newsItems.map((n) => n.title).join(" ").toLowerCase();
  const reasons = [];

  // --- trademark / likeness risk ---
  let risk = "low";
  const hitDomain = domains.find((d) => RISKY_DOMAINS.some((r) => d.endsWith(r)));
  if (hitDomain) {
    risk = "high";
    reasons.push(`Coverage from ${hitDomain} — league/studio/label IP very likely.`);
  }
  const hitTerm = RISKY_TERMS.find((t) => hasTerm(title, t) || hasTerm(headlineText, t));
  if (hitTerm && risk !== "high") {
    // A mark-bearing term in the topic itself is materially worse than one
    // that only appears in surrounding coverage.
    risk = hasTerm(title, hitTerm) ? "high" : "medium";
    reasons.push(`Contains "${hitTerm}" — commonly a protected mark or event name.`);
  }
  // A bare short proper-noun query is usually a person. Names carry publicity
  // and likeness rights even when nothing else flags.
  const words = item.title.trim().split(/\s+/);
  if (risk === "low" && words.length <= 3 && !POD_TERMS.some((t) => hasTerm(title, t))) {
    risk = "medium";
    reasons.push("Short proper-noun query — likely a person or brand (likeness/name rights).");
  }

  // --- POD relevance ---
  // Relevance is judged on the TOPIC only. News headlines around a topic are
  // used for risk, never to boost relevance — otherwise incidental vocabulary
  // in unrelated coverage inflates the score.
  let relevance = 0.25; // neutral prior
  const newsy = domains.some((d) => NEWS_DOMAINS.some((n) => d.endsWith(n)));
  const newsTerm = NEWS_TERMS.find((t) => hasTerm(title, t) || hasTerm(headlineText, t));
  if (newsy) {
    relevance -= 0.15;
    reasons.push("Mainstream news coverage — event-driven, not a durable merch niche.");
  }
  if (newsTerm) {
    relevance -= 0.15;
    reasons.push(`Reads as news/current affairs ("${newsTerm}") rather than an aesthetic.`);
  }
  const podTerm = POD_TERMS.find((t) => hasTerm(title, t));
  if (podTerm) {
    relevance += 0.5;
    reasons.push(`Matches print-on-demand vocabulary ("${podTerm}").`);
  }
  if (risk === "high") relevance -= 0.25;

  relevance = Math.max(0, Math.min(1, relevance));

  // Printable requires ALL of: no high trademark risk, genuine aesthetic
  // vocabulary in the topic itself, and no news/current-affairs character.
  // News topics are hard-excluded rather than merely penalised — a current
  // event can score well on vocabulary by coincidence and still be unsellable.
  const printable = risk === "low" && Boolean(podTerm) && !newsy && !newsTerm && relevance >= 0.5;

  return {
    trademarkRisk: risk,
    podRelevance: Math.round(relevance * 100) / 100,
    printable,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Google Trends daily trending searches.
 * First-party public RSS feed — no auth, no key, no scraping.
 * Note: undocumented, so treated as best-effort and allowed to fail.
 */
async function fetchTrends(geo) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const res = await fetch(url, { headers: { "user-agent": "ftw-labs-ai-signal-bot/1.0 (+https://ftwlabs.ai)" } });
  if (!res.ok) throw new Error(`Trends ${geo} HTTP ${res.status}`);
  const xml = await res.text();

  return allBlocks(xml, "item").map((block) => {
    const newsItems = allBlocks(block, "ht:news_item").map((n) => ({
      title: tagText(n, "ht:news_item_title"),
      url: tagText(n, "ht:news_item_url"),
      source: tagText(n, "ht:news_item_source"),
    }));
    const item = {
      title: tagText(block, "title"),
      traffic: parseTraffic(tagText(block, "ht:approx_traffic")),
      trafficLabel: tagText(block, "ht:approx_traffic"),
      pubDate: tagText(block, "pubDate"),
      geo,
      newsItems,
    };
    return { ...item, ...classify(item) };
  });
}

/**
 * YouTube trending — official Data API v3.
 * videos.list with chart=mostPopular costs 1 quota unit per call, so sweeping
 * a few regions daily is negligible against the 10,000/day allowance.
 * Public statistics only; watch time for videos you don't own is not exposed
 * by the API and is never claimed here.
 */
async function fetchYouTube(regionCode) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("regionCode", regionCode);
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("key", YOUTUBE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube ${regionCode} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();

  return (json.items || []).map((v) => ({
    videoId: v.id,
    title: v.snippet?.title ?? "",
    channel: v.snippet?.channelTitle ?? "",
    publishedAt: v.snippet?.publishedAt ?? "",
    tags: v.snippet?.tags ?? [],
    categoryId: v.snippet?.categoryId ?? "",
    views: Number(v.statistics?.viewCount ?? 0),
    likes: Number(v.statistics?.likeCount ?? 0),
    comments: Number(v.statistics?.commentCount ?? 0),
    regionCode,
    sourceUrl: `https://www.youtube.com/watch?v=${v.id}`,
  }));
}

/**
 * Printful catalog bestsellers — the one genuine cross-merchant popularity
 * signal either POD provider exposes. Important caveat carried into the
 * output: this ranks BLANK PRODUCTS (which tee/mug/poster sells best across
 * Printful), not designs, topics, or niches.
 *
 * Response shape is handled defensively: this path is unverified until it
 * runs once against a real token.
 */
async function fetchPrintfulBestsellers() {
  const url = "https://api.printful.com/v2/catalog-products?sort_type=bestseller&limit=20";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${PRINTFUL_TOKEN}` } });
  if (!res.ok) throw new Error(`Printful HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const rows = json?.data ?? json?.result ?? [];
  return (Array.isArray(rows) ? rows : []).map((p, i) => ({
    rank: i + 1,
    id: p?.id ?? null,
    name: p?.name ?? p?.title ?? "(unnamed)",
    brand: p?.brand ?? null,
    model: p?.model ?? null,
  }));
}

/**
 * Etsy niche competition scan — official Open API v3.
 *
 * This is the most directly useful market data in the whole pipeline. For each
 * evergreen niche it asks Etsy how many ACTIVE listings exist, what they cost,
 * and how heavily they're favourited. That answers the questions a POD seller
 * actually has: is this niche saturated, what's the going price, is anyone
 * paying attention.
 *
 * Deliberately NOT claimed as sales data. Etsy exposes no bestseller, sold, or
 * sales-rank endpoint at all — active listings are supply and interest, not
 * demand. `num_favorers` is the closest public proxy for interest.
 *
 * Auth: x-api-key must be "keystring:sharedsecret" (verified against the live
 * API; the docs describing keystring-only are out of date).
 * Quota: one call per niche per day, against 10 QPS / 10K QPD. Negligible.
 */
const ETSY_NICHES = [
  "cottagecore",
  "dark academia",
  "goblincore",
  "celestial tarot",
  "botanical line art",
  "plant lover gift",
  "cozy reading",
  "vintage camping",
];

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
}

/** Etsy money fields come back as {amount, divisor, currency_code}. */
function toPrice(price) {
  if (!price) return null;
  const amount = Number(price.amount);
  const divisor = Number(price.divisor) || 100;
  if (!Number.isFinite(amount)) return null;
  return Math.round((amount / divisor) * 100) / 100;
}

async function fetchEtsyNiche(niche, { logShape = false } = {}) {
  const url = new URL("https://openapi.etsy.com/v3/application/listings/active");
  url.searchParams.set("keywords", niche);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort_on", "score");

  const res = await fetch(url, { headers: { "x-api-key": ETSY_API_KEY } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Etsy "${niche}" HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();

  // First niche of the run logs the response shape, so the Actions log itself
  // becomes the record of what Etsy actually returns. Keys only — no listing
  // content, nothing sensitive.
  if (logShape) {
    console.log(`[etsy] top-level keys: ${Object.keys(json).join(", ")}`);
    const first = json?.results?.[0];
    if (first) console.log(`[etsy] result[0] keys: ${Object.keys(first).join(", ")}`);
  }

  const results = Array.isArray(json?.results) ? json.results : [];
  const prices = results.map((r) => toPrice(r?.price)).filter((p) => p !== null);
  const favorers = results.map((r) => Number(r?.num_favorers ?? 0)).filter(Number.isFinite);

  return {
    niche,
    // `count` is Etsy's total match count, not the page size — this is the
    // saturation number that matters.
    activeListings: Number(json?.count ?? results.length),
    sampled: results.length,
    medianPrice: median(prices),
    priceRange: prices.length ? { low: Math.min(...prices), high: Math.max(...prices) } : null,
    currency: results[0]?.price?.currency_code ?? null,
    medianFavorers: median(favorers),
    topFavorers: favorers.length ? Math.max(...favorers) : null,
    note: "Active listings = supply and interest. Etsy exposes no sold or bestseller data.",
  };
}

// ---------------------------------------------------------------------------
// "What to draw today"
//
// Evergreen niches lead; trending topics only modulate them. That ordering is
// deliberate — daily trending searches are mostly news and sport, and a
// pipeline that chased them would produce unsellable (or infringing) briefs.
// Everything here is explicitly model-inferred, never presented as demand data.
// ---------------------------------------------------------------------------

// `etsyKey` links each concept to its ETSY_NICHES query so the brief can carry
// real competition and pricing numbers instead of asserting a niche blind.
const EVERGREEN_NICHES = [
  { niche: "Cottagecore botanical", etsyKey: "cottagecore", motifs: ["pressed flowers", "mushroom clusters", "hand-lettered herbs"], products: ["graphic tee", "tote bag", "poster"] },
  { niche: "Dark academia", etsyKey: "dark academia", motifs: ["etched owl", "stacked antique books", "marginalia typography"], products: ["poster", "hoodie", "mug"] },
  { niche: "Celestial / tarot", etsyKey: "celestial tarot", motifs: ["moon phases", "hand-drawn tarot suit", "constellation map"], products: ["poster", "graphic tee", "sticker"] },
  { niche: "Cosy reading", etsyKey: "cozy reading", motifs: ["cat on a book stack", "tea and paperback", "library window light"], products: ["mug", "tote bag", "graphic tee"] },
  { niche: "Outdoors / van life", etsyKey: "vintage camping", motifs: ["retro park badge", "mountain line art", "camper silhouette"], products: ["graphic tee", "mug", "sticker"] },
  { niche: "Plant parent", etsyKey: "plant lover gift", motifs: ["single-line monstera", "propagation station", "terracotta row"], products: ["mug", "tote bag", "poster"] },
  { niche: "Goblincore / whimsy", etsyKey: "goblincore", motifs: ["frog in a hat", "snail and moss", "toadstool ring"], products: ["sticker", "tote bag", "graphic tee"] },
  { niche: "Seasonal spooky", etsyKey: "botanical line art", motifs: ["friendly ghost", "vintage pumpkin label", "black cat crescent"], products: ["graphic tee", "sticker", "mug"] },
];

function seasonalBias(dateStr) {
  const month = Number(dateStr.slice(5, 7));
  if (month === 9 || month === 10) return "Seasonal spooky";
  if (month === 11 || month === 12) return "Cosy reading";
  if (month >= 3 && month <= 5) return "Plant parent";
  if (month >= 6 && month <= 8) return "Outdoors / van life";
  return null;
}

function buildDrawBrief({ trends, printful, etsy = [], dateStr }) {
  const etsyFor = (key) => etsy.find((e) => e.niche === key) ?? null;
  const usableTrends = trends
    .filter((t) => t.printable)
    .sort((a, b) => b.traffic - a.traffic)
    .slice(0, 5);

  const bias = seasonalBias(dateStr);
  const ranked = [...EVERGREEN_NICHES].sort((a, b) => {
    if (a.niche === bias) return -1;
    if (b.niche === bias) return 1;
    return 0;
  });

  // Rotate the daily lead so consecutive days don't repeat the same brief.
  const dayIndex = Math.floor(Date.parse(dateStr) / 86_400_000);
  const lead = ranked[dayIndex % ranked.length];
  const support = ranked[(dayIndex + 3) % ranked.length];

  const bestBlank = printful?.[0]?.name ?? null;

  return {
    generatedFor: dateStr,
    basis: "model-inferred",
    disclaimer:
      "Model-inferred design direction, not demand data. Evergreen niches lead; " +
      "trending searches only modulate them, because daily trending topics are " +
      "mostly news and sport and rarely make sellable (or legally safe) merch.",
    lead: {
      niche: lead.niche,
      motifs: lead.motifs,
      suggestedProducts: lead.products,
      why: bias === lead.niche ? `Seasonally weighted for ${dateStr.slice(0, 7)}.` : "Evergreen rotation.",
      market: etsyFor(lead.etsyKey),
    },
    support: { niche: support.niche, motifs: support.motifs, market: etsyFor(support.etsyKey) },
    blankSuggestion: bestBlank
      ? { product: bestBlank, source: "Printful catalog bestseller ranking", note: "Ranks blank products across Printful — not designs or niches." }
      : null,
    timelyHooks: usableTrends.map((t) => ({
      topic: t.title,
      geo: t.geo,
      traffic: t.trafficLabel,
      trademarkRisk: t.trademarkRisk,
      caution: "Verify trademark/likeness clearance before printing anything tied to a trending topic.",
    })),
    timelyHookNote:
      usableTrends.length === 0
        ? "No trending search today passed both the printability and trademark-safety filters. That is a normal result — most days, evergreen is the better bet."
        : `${usableTrends.length} trending topic(s) passed filtering. Still verify clearance yourself.`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sources = [];
  const errors = [];

  // --- Google Trends (always attempted; needs no credentials) ---
  let trends = [];
  for (const geo of GEOS) {
    try {
      const items = await fetchTrends(geo);
      trends.push(...items);
      sources.push({ id: `google_trends_rss:${geo}`, status: "ok", count: items.length, license: "public_first_party_feed", confidence: "medium" });
    } catch (err) {
      errors.push(`trends:${geo}: ${err.message}`);
      sources.push({ id: `google_trends_rss:${geo}`, status: "failed", error: err.message });
    }
  }

  // --- YouTube (optional) ---
  let youtube = [];
  if (YOUTUBE_API_KEY) {
    for (const region of GEOS) {
      try {
        const vids = await fetchYouTube(region);
        youtube.push(...vids);
        sources.push({ id: `youtube_data_api:${region}`, status: "ok", count: vids.length, license: "official_api", confidence: "high" });
      } catch (err) {
        errors.push(`youtube:${region}: ${err.message}`);
        sources.push({ id: `youtube_data_api:${region}`, status: "failed", error: err.message });
      }
    }
  } else {
    sources.push({ id: "youtube_data_api", status: "not_configured", note: "Set YOUTUBE_API_KEY to enable." });
  }

  // --- Printful bestsellers (optional) ---
  let printful = [];
  if (PRINTFUL_TOKEN) {
    try {
      printful = await fetchPrintfulBestsellers();
      sources.push({ id: "printful_catalog_bestsellers", status: "ok", count: printful.length, license: "official_api", confidence: "high" });
    } catch (err) {
      errors.push(`printful: ${err.message}`);
      sources.push({ id: "printful_catalog_bestsellers", status: "failed", error: err.message });
    }
  } else {
    sources.push({ id: "printful_catalog_bestsellers", status: "not_configured", note: "Set PRINTFUL_TOKEN to enable." });
  }

  // --- Etsy niche competition (optional) ---
  let etsy = [];
  if (ETSY_API_KEY) {
    for (const [i, niche] of ETSY_NICHES.entries()) {
      try {
        etsy.push(await fetchEtsyNiche(niche, { logShape: i === 0 }));
      } catch (err) {
        errors.push(`etsy:${niche}: ${err.message}`);
      }
      // Stay well inside 10 QPS even though 8 sequential calls never approach it.
      await new Promise((r) => setTimeout(r, 150));
    }
    sources.push(
      etsy.length > 0
        ? { id: "etsy_open_api_v3", status: "ok", count: etsy.length, license: "official_api", confidence: "high" }
        : { id: "etsy_open_api_v3", status: "failed", error: "All niche queries failed — see errors." },
    );
  } else {
    sources.push({ id: "etsy_open_api_v3", status: "not_configured", note: "Set ETSY_API_KEY as 'keystring:sharedsecret'." });
  }

  trends.sort((a, b) => b.traffic - a.traffic);
  youtube.sort((a, b) => b.views - a.views);
  etsy.sort((a, b) => (b.medianFavorers ?? 0) - (a.medianFavorers ?? 0));

  const snapshot = {
    date: today,
    generatedAt: new Date().toISOString(),
    sources,
    errors,
    counts: {
      trends: trends.length,
      trendsPrintable: trends.filter((t) => t.printable).length,
      youtube: youtube.length,
      printfulBestsellers: printful.length,
      etsyNiches: etsy.length,
    },
    trends,
    youtube,
    printfulBestsellers: printful,
    etsyNiches: etsy,
    drawBrief: buildDrawBrief({ trends, printful, etsy, dateStr: today }),
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, `${today}.json`), JSON.stringify(snapshot, null, 2));
  await writeFile(LATEST_FILE, JSON.stringify(snapshot, null, 2));

  // --- rolling history: this is what makes the charts real over time ---
  let history = [];
  if (existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(await readFile(HISTORY_FILE, "utf8"));
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
  }
  // Compact daily rollup — the full snapshot stays in the dated file.
  const rollup = {
    date: today,
    topTrends: trends.slice(0, 20).map((t) => ({ title: t.title, traffic: t.traffic, geo: t.geo, printable: t.printable, trademarkRisk: t.trademarkRisk })),
    topVideos: youtube.slice(0, 10).map((v) => ({ title: v.title, views: v.views, channel: v.channel, videoId: v.videoId })),
    // Tracked daily so niche saturation and pricing can be charted over time —
    // this is the series that turns into a real trend line as days accumulate.
    etsyNiches: etsy.map((e) => ({ niche: e.niche, activeListings: e.activeListings, medianPrice: e.medianPrice, medianFavorers: e.medianFavorers })),
    counts: snapshot.counts,
  };
  history = history.filter((h) => h.date !== today);
  history.push(rollup);
  history.sort((a, b) => a.date.localeCompare(b.date));
  history = history.slice(-HISTORY_DAYS);
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));

  console.log(`[signals] ${today}`);
  console.log(`  trends: ${trends.length} (${snapshot.counts.trendsPrintable} passed printability+TM filter)`);
  console.log(`  youtube: ${youtube.length}`);
  console.log(`  printful bestsellers: ${printful.length}`);
  console.log(`  etsy niches: ${etsy.length}`);
  console.log(`  history: ${history.length} day(s)`);
  if (errors.length) console.log(`  errors: ${errors.length}\n   - ${errors.join("\n   - ")}`);

  // Every source failing means the run produced nothing worth committing.
  if (trends.length === 0 && youtube.length === 0 && printful.length === 0 && etsy.length === 0) {
    console.error("[signals] no data from any source — failing so the run is visibly red.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[signals] fatal:", err);
  process.exit(1);
});
