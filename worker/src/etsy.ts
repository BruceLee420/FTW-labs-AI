/**
 * Etsy Open API v3 adapter — the storefront that actually takes money.
 *
 * WHY ETSY AND NOT PRINTFUL
 * -------------------------
 * The intuitive design is "push the product to Printful, let Printful put it
 * on Etsy." That is not available. Printful's Products API is documented as
 * working only against a store on the *Manual order / API* platform:
 *
 *   "The Products API resource lets you create, modify and delete products in
 *    a Printful store based on the Manual orders / API platform."
 *
 * A Printful store connected to Etsy is an integration-platform store, so
 * `POST /store/products` cannot create listings on it. Printful's own docs are
 * blunt about the general case: the Products API "is not intended and will
 * never support creating and managing products in external platforms."
 *
 * So the listing is created directly on Etsy. See the fulfilment note at the
 * bottom of this file — that gap is real and is not papered over here.
 *
 * WHY THE CALL SHAPES ARE TRUSTWORTHY
 * -----------------------------------
 * Every field, enum, HTTP method and content type below was read out of Etsy's
 * published OpenAPI document (etsy.com/openapi/generated/oas/3.0.0.json),
 * not from prose docs or memory. That matters here: `createDraftListing` is
 * `application/x-www-form-urlencoded`, NOT JSON, which is the single easiest
 * way to get a 400 on the first real run.
 */

/** Tokens as stored in KV. */
export interface EtsyTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
}

export interface EtsyEnv {
  ETSY_STORE?: KVNamespace;
  /** App keystring. A public identifier, not a secret. */
  ETSY_KEYSTRING?: string;
  /** Where Etsy sends the user back. Must match the app registration exactly. */
  ETSY_REDIRECT_URI?: string;
  /** Optional override; otherwise discovered via /users/me and cached. */
  ETSY_SHOP_ID?: string;

  // Listing defaults. Every one of these is required by Etsy on create, so
  // they are configuration rather than per-item data.
  ETSY_TAXONOMY_ID?: string;
  ETSY_QUANTITY?: string;
  ETSY_WHO_MADE?: string;
  ETSY_WHEN_MADE?: string;
  ETSY_SHIPPING_PROFILE_ID?: string;
  ETSY_RETURN_POLICY_ID?: string;
}

const API = "https://api.etsy.com/v3/application";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const CONNECT_URL = "https://www.etsy.com/oauth/connect";

/**
 * Scopes we ask for, and why each one is needed:
 *   listings_w  — create the draft, upload its image, set it active
 *   listings_r  — read a listing back after writing it
 *   shops_r     — resolve which shop the signed-in seller owns (/users/me)
 */
export const ETSY_SCOPES = "listings_w listings_r shops_r";

const TOKENS_KEY = "etsy:tokens";
const SHOP_KEY = "etsy:shop_id";
const PENDING_PREFIX = "etsy:oauth:";
/** Refresh a little early so a call never races the expiry. */
const EXPIRY_SKEW_SECONDS = 120;

const nowSec = () => Math.floor(Date.now() / 1000);

export class EtsyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * OAuth (PKCE)
 * ------------------------------------------------------------------ */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64Url(byteLength: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function requireConfig(env: EtsyEnv): { kv: KVNamespace; keystring: string; redirectUri: string } {
  if (!env.ETSY_STORE) throw new EtsyError("ETSY_STORE KV namespace is not bound to this Worker.");
  if (!env.ETSY_KEYSTRING) throw new EtsyError("ETSY_KEYSTRING is not set.");
  if (!env.ETSY_REDIRECT_URI) throw new EtsyError("ETSY_REDIRECT_URI is not set.");
  return { kv: env.ETSY_STORE, keystring: env.ETSY_KEYSTRING, redirectUri: env.ETSY_REDIRECT_URI };
}

/**
 * Begin the OAuth flow. Returns the URL to send the seller to.
 *
 * The `state` is not decoration. The callback has to be reachable without an
 * Access login (Etsy's redirect cannot pass a login screen), so it is the one
 * unauthenticated endpoint on this Worker. Binding the callback to a `state`
 * this Worker minted — inside an Access-protected request — is what stops a
 * stranger from walking the callback and planting *their* Etsy token in our
 * KV. The verifier is stored next to it so PKCE completes server-side.
 */
export async function beginOAuth(env: EtsyEnv): Promise<string> {
  const { kv, keystring, redirectUri } = requireConfig(env);

  const state = randomB64Url(24);
  const verifier = randomB64Url(48);
  const challenge = await s256(verifier);

  // Short TTL: a login the seller abandons should not leave a usable slot open.
  await kv.put(PENDING_PREFIX + state, verifier, { expirationTtl: 600 });

  const url = new URL(CONNECT_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", keystring);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", ETSY_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Complete the OAuth flow. Throws unless `state` matches one we minted. */
export async function completeOAuth(env: EtsyEnv, code: string, state: string): Promise<void> {
  const { kv, keystring, redirectUri } = requireConfig(env);

  const verifier = await kv.get(PENDING_PREFIX + state);
  if (!verifier) {
    throw new EtsyError("This sign-in link has expired or was not started here. Start again from the dashboard.", 400);
  }
  // One shot. A replayed callback must not succeed.
  await kv.delete(PENDING_PREFIX + state);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: keystring,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new EtsyError(`Etsy rejected the authorization code: ${text}`, res.status);

  const json = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
  await saveTokens(kv, {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: nowSec() + (json.expires_in ?? 3600),
  });
  // Force re-discovery in case this is a different seller than last time.
  await kv.delete(SHOP_KEY);
}

async function saveTokens(kv: KVNamespace, tokens: EtsyTokens): Promise<void> {
  await kv.put(TOKENS_KEY, JSON.stringify(tokens));
}

export async function readTokens(env: EtsyEnv): Promise<EtsyTokens | null> {
  if (!env.ETSY_STORE) return null;
  const raw = await env.ETSY_STORE.get(TOKENS_KEY);
  return raw ? (JSON.parse(raw) as EtsyTokens) : null;
}

/**
 * A valid access token, refreshing if needed.
 *
 * Etsy access tokens last an hour and refresh tokens 90 days, so an account
 * that is quiet for three months has to be reconnected by hand. The error says
 * so rather than failing as a generic 401 that looks like a bug.
 */
async function accessToken(env: EtsyEnv): Promise<string> {
  const { kv, keystring } = requireConfig(env);
  const tokens = await readTokens(env);
  if (!tokens) throw new EtsyError("Etsy is not connected. Visit /api/studio/etsy/connect to authorize.", 401);

  if (tokens.expires_at - EXPIRY_SKEW_SECONDS > nowSec()) return tokens.access_token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: keystring,
      refresh_token: tokens.refresh_token,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new EtsyError(
      `Etsy refused to refresh the token (${res.status}). Refresh tokens expire after 90 days — ` +
        `reconnect at /api/studio/etsy/connect. Response: ${text}`,
      res.status,
    );
  }

  const json = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
  const next: EtsyTokens = {
    access_token: json.access_token,
    // Etsy rotates the refresh token; keeping the old one would strand us.
    refresh_token: json.refresh_token ?? tokens.refresh_token,
    expires_at: nowSec() + (json.expires_in ?? 3600),
  };
  await saveTokens(kv, next);
  return next.access_token;
}

/* ------------------------------------------------------------------ *
 * API calls
 * ------------------------------------------------------------------ */

async function call(
  env: EtsyEnv,
  path: string,
  init: { method?: string; body?: BodyInit; contentType?: string } = {},
): Promise<unknown> {
  const token = await accessToken(env);
  const headers: Record<string, string> = {
    // With a Bearer token present Etsy expects the keystring alone here.
    // (App-only, unauthenticated calls are the case that needs the combined
    // "keystring:sharedsecret" form — see scripts/fetch-signals.mjs.)
    "x-api-key": env.ETSY_KEYSTRING!,
    Authorization: `Bearer ${token}`,
  };
  if (init.contentType) headers["Content-Type"] = init.contentType;

  const res = await fetch(`${API}${path}`, { method: init.method ?? "GET", headers, body: init.body });
  const text = await res.text();
  if (!res.ok) {
    // Etsy's error bodies name the offending field. Surfacing the body
    // verbatim is the difference between a one-look fix and a guessing game.
    throw new EtsyError(`Etsy ${init.method ?? "GET"} ${path} failed (${res.status}): ${text}`, res.status);
  }
  return text ? JSON.parse(text) : null;
}

/** The seller's shop id, cached — `/users/me` returns it directly. */
export async function resolveShopId(env: EtsyEnv): Promise<string> {
  if (env.ETSY_SHOP_ID) return env.ETSY_SHOP_ID;
  const { kv } = requireConfig(env);

  const cached = await kv.get(SHOP_KEY);
  if (cached) return cached;

  const me = (await call(env, "/users/me")) as { user_id?: number; shop_id?: number };
  if (!me?.shop_id) {
    throw new EtsyError(
      "This Etsy account has no shop. Open a shop on Etsy first, or set ETSY_SHOP_ID if you know it.",
    );
  }
  const shopId = String(me.shop_id);
  await kv.put(SHOP_KEY, shopId);
  return shopId;
}

/**
 * Etsy tag rules, enforced here rather than discovered via a 400: at most 13
 * tags, 20 characters each, letters/numbers/spaces/hyphens only. One bad tag
 * rejects the entire listing, so they are cleaned instead of passed through.
 */
export function cleanTags(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.replace(/[^a-zA-Z0-9 -]/g, "").trim().slice(0, 20);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
    if (out.length === 13) break;
  }
  return out;
}

export interface ListingDraft {
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  tags: string | null;
}

function listingDefaults(env: EtsyEnv) {
  const taxonomyId = Number(env.ETSY_TAXONOMY_ID);
  if (!Number.isFinite(taxonomyId) || taxonomyId < 1) {
    throw new EtsyError(
      "ETSY_TAXONOMY_ID is not set. Etsy requires a category on every listing; " +
        "pick one from GET /v3/application/seller-taxonomy/nodes.",
    );
  }
  return {
    taxonomyId,
    quantity: Number(env.ETSY_QUANTITY) || 999,
    whoMade: env.ETSY_WHO_MADE || "i_did",
    whenMade: env.ETSY_WHEN_MADE || "made_to_order",
    shippingProfileId: env.ETSY_SHIPPING_PROFILE_ID,
    returnPolicyId: env.ETSY_RETURN_POLICY_ID,
  };
}

/**
 * Create the listing, attach the artwork, and take it live.
 *
 * The order is not arbitrary. Etsy's spec on `updateListing.state`:
 * "Setting a `draft` listing to `active` will also publish the listing on
 * etsy.com and requires that the listing have an image set." Activating before
 * the image lands therefore fails — draft, then image, then active.
 *
 * If activation fails the draft is deliberately left in place rather than
 * cleaned up: a draft in the seller's dashboard is recoverable, whereas a
 * delete would throw away the artwork upload too.
 */
export async function publishListing(
  env: EtsyEnv,
  draft: ListingDraft,
  image: { bytes: ArrayBuffer; contentType: string; filename: string },
): Promise<{ listingId: string; url: string }> {
  const shopId = await resolveShopId(env);
  const d = listingDefaults(env);

  const form = new URLSearchParams({
    quantity: String(d.quantity),
    title: draft.title.slice(0, 140),
    description: draft.description,
    // Etsy takes a decimal amount, not minor units.
    price: (draft.priceCents / 100).toFixed(2),
    who_made: d.whoMade,
    when_made: d.whenMade,
    taxonomy_id: String(d.taxonomyId),
    type: "physical",
  });
  const tags = cleanTags(draft.tags);
  if (tags.length) form.set("tags", tags.join(","));
  if (d.shippingProfileId) form.set("shipping_profile_id", d.shippingProfileId);
  if (d.returnPolicyId) form.set("return_policy_id", d.returnPolicyId);

  const created = (await call(env, `/shops/${shopId}/listings`, {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form,
  })) as { listing_id?: number };

  const listingId = created?.listing_id;
  if (!listingId) throw new EtsyError("Etsy accepted the draft but returned no listing_id.");

  const upload = new FormData();
  upload.append("image", new Blob([image.bytes], { type: image.contentType }), image.filename);
  upload.append("rank", "1");
  // Content-Type is omitted on purpose — fetch must set the multipart boundary.
  await call(env, `/shops/${shopId}/listings/${listingId}/images`, { method: "POST", body: upload });

  await call(env, `/shops/${shopId}/listings/${listingId}`, {
    method: "PATCH",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ state: "active" }),
  });

  return { listingId: String(listingId), url: `https://www.etsy.com/listing/${listingId}` };
}

/**
 * Push an edit to a listing that is already live.
 *
 * `updateListing` accepts title, description and tags. It does NOT accept
 * price or quantity — those live behind `updateListingInventory`, which
 * requires reading the whole inventory structure back, stripping its
 * read-only fields and PUTting it in full. That is not implemented, and a
 * price change is reported as an error rather than silently dropped: an edit
 * that looks saved but never reaches the storefront is how you end up selling
 * at the old price without knowing it.
 */
export async function updateListing(
  env: EtsyEnv,
  listingId: string,
  patch: { title?: string; description?: string; tags?: string | null },
): Promise<void> {
  const shopId = await resolveShopId(env);
  const form = new URLSearchParams();
  if (patch.title !== undefined) form.set("title", patch.title.slice(0, 140));
  if (patch.description !== undefined) form.set("description", patch.description);
  if (patch.tags !== undefined) form.set("tags", cleanTags(patch.tags).join(","));
  if ([...form.keys()].length === 0) return;

  await call(env, `/shops/${shopId}/listings/${listingId}`, {
    method: "PATCH",
    contentType: "application/x-www-form-urlencoded",
    body: form,
  });
}

/** Diagnostics for the dashboard: what is configured, what is missing. */
export async function status(env: EtsyEnv): Promise<Record<string, unknown>> {
  const missing: string[] = [];
  if (!env.ETSY_STORE) missing.push("ETSY_STORE (KV binding)");
  if (!env.ETSY_KEYSTRING) missing.push("ETSY_KEYSTRING");
  if (!env.ETSY_REDIRECT_URI) missing.push("ETSY_REDIRECT_URI");
  if (!env.ETSY_TAXONOMY_ID) missing.push("ETSY_TAXONOMY_ID");

  const tokens = await readTokens(env).catch(() => null);
  let shopId: string | null = null;
  let shopError: string | null = null;
  if (tokens) {
    try {
      shopId = await resolveShopId(env);
    } catch (err) {
      shopError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    connected: Boolean(tokens),
    // Never return the tokens themselves — only whether they are usable.
    tokenExpiresAt: tokens?.expires_at ?? null,
    tokenExpired: tokens ? tokens.expires_at <= nowSec() : null,
    shopId,
    shopError,
    missingConfig: missing,
    scopes: ETSY_SCOPES,
  };
}

/*
 * FULFILMENT — the honest gap.
 *
 * A listing created through Etsy's API has no link to a Printful sync product,
 * so when it sells, Printful will not auto-fulfil it. The order still arrives
 * in Printful's dashboard via the Etsy order sync, but unmatched: you pick the
 * blank and the print file for the first order of each design by hand.
 *
 * There is no API that closes this, because the API that would (Printful's
 * Products API) does not operate on integration-platform stores. The options
 * are: match the order by hand once per design, or create the product in
 * Printful's dashboard and let it push the listing, which gives up the
 * automation this pipeline exists for.
 */
