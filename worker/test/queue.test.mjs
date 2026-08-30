/** publishToStore branching — the money-affecting decisions. */
import assert from "node:assert/strict";
import { publishToStore, evaluateHolds } from "./queue.bundle.mjs";

let pass = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
  const u = String(url);
  if (u.includes("/public/oauth/token")) {
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
  }
  if (u.endsWith("/users/me")) return new Response(JSON.stringify({ shop_id: 42 }), { status: 200 });
  if (u.endsWith("/listings") && init.method === "POST") {
    return new Response(JSON.stringify({ listing_id: 111 }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};

const store = new Map([["etsy:tokens", JSON.stringify({ access_token: "at", refresh_token: "rt", expires_at: 2 ** 40 })]]);
const env = {
  PUBLISH_ENABLED: "true",
  ETSY_STORE: {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  },
  ETSY_KEYSTRING: "ks",
  ETSY_REDIRECT_URI: "https://x/cb",
  ETSY_TAXONOMY_ID: "1029",
  DROPS: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer, httpMetadata: { contentType: "image/png" } }) },
};

const base = {
  id: "a", r2_key: "drops/final/x.png", stage: "final",
  title: "Neon Skull Print Poster", description: "d".repeat(60), tags: "skull",
  price_cents: 2400, currency: "USD", base_cost_cents: 1000, margin_floor_pct: 21,
  status: "queued", hold_reasons: null, publish_after: 1, paused: 0,
  external_id: null, external_url: null, published_price_cents: null,
  attempts: 0, last_error: null, created_at: 1, updated_at: 1, published_at: null,
};

console.log("\npublishToStore");
{
  calls.length = 0;
  const r = await publishToStore({ ...base }, env);
  assert.deepEqual(r, { ok: true, externalId: "111", externalUrl: "https://www.etsy.com/listing/111" });
  ok("a fresh row creates a listing and returns its id + URL");

  const r2 = await publishToStore({ ...base, title: null }, env);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Missing title/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/listings")).length, 1);
  ok("a row with no copy is refused without any API call");

  calls.length = 0;
  const r3 = await publishToStore({ ...base, external_id: "111", external_url: "u", published_price_cents: 2400 }, env);
  assert.equal(r3.ok, true);
  assert.equal(r3.externalId, "111");
  assert.equal(calls.filter((c) => c.url.endsWith("/listings") && c.method === "POST").length, 0);
  ok("an already-live row edits in place — never creates a duplicate listing");

  calls.length = 0;
  const r4 = await publishToStore(
    { ...base, external_id: "111", external_url: "u", published_price_cents: 2400, price_cents: 1900 },
    env,
  );
  assert.equal(r4.ok, false);
  assert.match(r4.error, /cannot set price/);
  assert.equal(calls.length, 0, "must not write a partial update");
  ok("a price change on a live listing FAILS loudly instead of silently not applying");

  const r5 = await publishToStore({ ...base }, { ...env, DROPS: { get: async () => null } });
  assert.equal(r5.ok, false);
  assert.match(r5.error, /no longer in the bucket/);
  ok("missing artwork is reported, not published as an empty listing");
}

console.log("\nevaluateHolds (unchanged safety net)");
{
  assert.deepEqual(evaluateHolds({ ...base }), []);
  ok("a complete, profitable Final passes");
  assert.match(evaluateHolds({ ...base, price_cents: 1100 })[0], /below your 21% floor/);
  ok("a sub-floor margin is held");
  assert.match(evaluateHolds({ ...base, stage: "wip" }).at(-1), /Only pieces marked Final/);
  ok("a WIP is held");
}

console.log(`\n${pass} checks passed.`);
