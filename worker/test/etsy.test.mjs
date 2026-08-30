/**
 * Verifies the Etsy adapter's wire format against Etsy's published OpenAPI
 * document. No network: fetch is stubbed and every outgoing request recorded,
 * then each one is checked against the spec's own required fields, enums,
 * methods and content types.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publishListing, updateListing, cleanTags, beginOAuth, completeOAuth } from "./etsy.bundle.mjs";

const spec = JSON.parse(readFileSync(new URL("./etsy-oas.json", import.meta.url)));
const CREATE = "/v3/application/shops/{shop_id}/listings";
const createOp = spec.paths[CREATE].post;
const createSchema = createOp.requestBody.content["application/x-www-form-urlencoded"].schema;

const calls = [];
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok  ${name}`); };

// Minimal in-memory KV.
const store = new Map();
const KV = {
  get: async (k) => (store.has(k) ? store.get(k) : null),
  put: async (k, v) => void store.set(k, v),
  delete: async (k) => void store.delete(k),
};

const env = {
  ETSY_STORE: KV,
  ETSY_KEYSTRING: "test-keystring",
  ETSY_REDIRECT_URI: "https://ftwlabs.ai/api/studio/etsy/callback",
  ETSY_TAXONOMY_ID: "1029",
  ETSY_SHIPPING_PROFILE_ID: "555",
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const rec = { url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
  calls.push(rec);

  if (u.includes("/public/oauth/token")) {
    return new Response(
      JSON.stringify({ access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }),
      { status: 200 },
    );
  }
  if (u.endsWith("/users/me")) return new Response(JSON.stringify({ user_id: 7, shop_id: 424242 }), { status: 200 });
  if (u.endsWith("/listings") && rec.method === "POST") {
    return new Response(JSON.stringify({ listing_id: 987654321 }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
};

// ---------------------------------------------------------------- OAuth
console.log("\nOAuth (PKCE + state)");
{
  const url = new URL(await beginOAuth(env));
  assert.equal(url.origin + url.pathname, "https://www.etsy.com/oauth/connect");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.match(url.searchParams.get("scope"), /listings_w/);
  ok("connect URL carries PKCE S256 challenge, state and listings_w scope");

  const state = url.searchParams.get("state");
  await assert.rejects(() => completeOAuth(env, "code", "not-the-state"), /expired or was not started here/);
  ok("callback with a forged state is refused (no token written)");

  await completeOAuth(env, "the-code", state);
  assert.equal(JSON.parse(store.get("etsy:tokens")).access_token, "at-1");
  ok("callback with the minted state stores tokens");

  await assert.rejects(() => completeOAuth(env, "the-code", state), /expired or was not started here/);
  ok("state is single-use — a replayed callback is refused");
}

// ------------------------------------------------------------- publish
console.log("\npublishListing — wire format vs Etsy's OpenAPI spec");
calls.length = 0;
const result = await publishListing(
  env,
  {
    title: "x".repeat(200), // over Etsy's 140 limit on purpose
    description: "A hand-drawn print.",
    priceCents: 2400,
    currency: "USD",
    tags: "skull, skull, neon-glow, this tag is far too long to be legal, bad*chars!, a,b,c,d,e,f,g,h,i,j,k",
  },
  { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, contentType: "image/png", filename: "art.png" },
);

const create = calls.find((c) => c.url.endsWith("/listings") && c.method === "POST");
const img = calls.find((c) => c.url.includes("/images"));
const activate = calls.find((c) => c.method === "PATCH");

assert.equal(create.headers["Content-Type"], "application/x-www-form-urlencoded");
ok("create uses form-urlencoded, not JSON (spec: application/x-www-form-urlencoded)");

const sent = new URLSearchParams(create.body.toString());
for (const field of createSchema.required) {
  assert.ok(sent.has(field), `missing spec-required field: ${field}`);
}
ok(`every spec-required field present: ${createSchema.required.join(", ")}`);

for (const [field, def] of Object.entries(createSchema.properties)) {
  if (def.enum && sent.has(field)) {
    assert.ok(def.enum.includes(sent.get(field)), `${field}="${sent.get(field)}" not in spec enum`);
  }
}
ok("every enum value sent is one the spec allows (who_made, when_made, type)");

assert.equal(sent.get("price"), "24.00");
ok("price sent as a decimal amount, not minor units");

assert.equal(sent.get("title").length, 140);
ok("title clamped to Etsy's 140-char limit");

const tags = sent.get("tags").split(",");
assert.equal(tags.length, 13, `expected 13 tags, got ${tags.length}`);
assert.ok(tags.every((t) => t.length <= 20 && /^[a-zA-Z0-9 -]+$/.test(t)), `illegal tag in: ${tags}`);
assert.equal(new Set(tags.map((t) => t.toLowerCase())).size, tags.length);
ok("tags: deduped, illegal characters stripped, ≤20 chars, capped at 13");

assert.equal(create.headers["x-api-key"], "test-keystring");
assert.equal(create.headers.Authorization, "Bearer at-1");
ok("auth headers: keystring in x-api-key, bearer token in Authorization");

const order = calls.filter((c) => !c.url.includes("oauth")).map((c) => c.url.split("/v3/application")[1] + ` [${c.method}]`);
assert.ok(order.indexOf(order.find((o) => o.includes("/images"))) < order.indexOf(order.find((o) => o.includes("[PATCH]"))));
ok("ordering: draft created, THEN image attached, THEN set active");

assert.ok(img.body instanceof FormData && img.body.get("image"));
assert.ok(!("Content-Type" in img.headers), "must not set Content-Type — fetch owns the multipart boundary");
ok("image upload is multipart with an `image` part and no hand-set boundary");

assert.equal(new URLSearchParams(activate.body.toString()).get("state"), "active");
ok("activation PATCHes state=active");

assert.deepEqual(result, { listingId: "987654321", url: "https://www.etsy.com/listing/987654321" });
ok("returns the listing id and its public URL");

// --------------------------------------------------------------- update
console.log("\nupdateListing");
calls.length = 0;
await updateListing(env, "987654321", { title: "New title", description: "New copy.", tags: "a,b" });
const patch = new URLSearchParams(calls.at(-1).body.toString());
assert.deepEqual([...patch.keys()].sort(), ["description", "tags", "title"]);
ok("sends only fields updateListing accepts — never price or quantity");

calls.length = 0;
await updateListing(env, "987654321", {});
assert.equal(calls.length, 0);
ok("an empty patch makes no request at all");

// ------------------------------------------------------------- refresh
console.log("\nToken refresh");
store.set("etsy:tokens", JSON.stringify({ access_token: "stale", refresh_token: "rt-2", expires_at: 0 }));
calls.length = 0;
await updateListing(env, "1", { title: "t" });
const refresh = calls.find((c) => c.url.includes("/public/oauth/token"));
assert.equal(new URLSearchParams(refresh.body.toString()).get("grant_type"), "refresh_token");
assert.equal(calls.at(-1).headers.Authorization, "Bearer at-1");
ok("an expired token is refreshed before the call, and the new one is used");

console.log(`\n${pass} checks passed.`);
