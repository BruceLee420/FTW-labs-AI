# Studio Drop — setup and security model

The drop box: sign in, drag today's art in, pick Sketch / WIP / Final, walk
away. Storage is Cloudflare R2; the front door is Cloudflare Access.

**Only a piece explicitly marked Final ever publishes.** It gets a grace
window in the review queue first — edit it and the clock restarts; leave it
and it ships itself. See Auto-deploy below.

---

## Why this doesn't use pre-signed URLs

The common pattern is a Worker that mints S3 pre-signed `PUT` URLs so the
browser uploads straight to R2. We deliberately do **not** do that:

| | Pre-signed URLs | What we do (R2 binding) |
|---|---|---|
| R2 access keys | Must live in the Worker | **None exist at all** |
| Bucket CORS | Required, easy to get wrong | Not needed |
| Server sees the bytes | No — only mints a URL | Yes — validates real content |
| Content-Type | Whatever was signed | Chosen by the server from an allowlist |
| Max file size | 5 GiB | 100 MB (Workers request-body cap) |

Pre-signing exists to dodge a request-size limit we never hit. Art drops are
≤50 MB and Workers accept 100 MB bodies on the free plan, so the file streams
through the Worker into the R2 binding. That removes the S3 credential
entirely — the very thing the pre-signed design was meant to protect.

**When this design stops working:** files over ~100 MB. At that point you need
pre-signed uploads (R2 accepts 5 GiB single-part), and you accept the access
key. Raising the Worker body cap to 200 MB needs a Business zone, which is not
worth it for this.

---

## Threat model — what each control actually stops

| Risk | Control |
|---|---|
| Anyone on the internet uploading to your bucket | **Cloudflare Access.** Unauthenticated requests never reach the Worker. This is the control that matters. |
| Storage-cost abuse (~$15 per TB/month, recurring) | Access, plus a per-user rate limit and a hard 50 MB cap enforced **on the wire**, not from `Content-Length` |
| Stored XSS — hostile file served as active content from your domain | Bucket stays **private**. Reads go through the Worker with a forced `Content-Type` from the allowlist, `nosniff`, and a locked-down CSP. A `.html` disguised as an image can never execute. |
| Content-type spoofing | Type is confirmed against the file's **magic bytes**, and the stored type comes from the server allowlist — the client's claim is advisory only |
| Info leak via errors | Client gets a generic message; the detail goes to the Worker log |
| Accidental publish | Stage defaults to **Sketch**; only an explicit Final, behind a confirmation code, is publish-eligible. Final then auto-publishes after the grace window — the hold conditions below are what stop a bad one. |

### The confirmation code is not authentication

A 4-digit code is 10,000 combinations — trivially brute-forced, and it ships
inside the client bundle where anyone can read it. It exists to answer *"did
you mean to publish this?"*, not *"who are you?"*

**Cloudflare Access answers "who are you."** Never treat the code as the lock.

### Egress is free on R2

This removes the classic bandwidth-bankruptcy risk. The remaining exposure is
**storage** (~$0.015/GB-month, recurring until deleted) — which is why the
write path is gated and size-capped. Deletes are free, so cleaning up after an
incident costs nothing.

---

## Setup

### 1. R2 bucket

```bash
npx wrangler r2 bucket create ftw-studio-drops
```

**Leave it private.** Do not enable the `r2.dev` public subdomain — Cloudflare
documents it as development-only and rate-limited, and leaving it on is an open
back door around every control below. Reads are served by the Worker.

Optionally add a lifecycle rule to bound storage growth over time.

### 2. Cloudflare Access

Zero Trust dashboard → **Access → Applications → Add a self-hosted app**:

- **Application domain:** `ftwlabs.ai`, path `api/studio`
- **Policy:** Allow → *Emails* → your address
- **Login methods:** One-time PIN needs zero setup (Cloudflare emails you a
  code). Google works too, and doesn't require Workspace.

Then copy the application's **Audience (AUD) tag** from its Overview tab.

> Free tier is widely cited as 50 users, but that number isn't stated on
> current Cloudflare developer docs — confirm in your dashboard. For one
> person it's academic.

### 3. Worker vars

In `worker/wrangler.toml`, uncomment and fill:

```toml
[vars]
ALLOWED_ORIGIN     = "https://ftwlabs.ai"
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD         = "<the AUD tag from step 2>"
```

None of these are secrets — the AUD tag is a public identifier, and the Worker
verifies tokens against Cloudflare's published JWKS.

### 4. Deploy

```bash
cd worker
npm install
npm run typecheck
npm run deploy
```

### 5. Point the dashboard at it

Build TrendForge with:

```bash
VITE_STUDIO_WORKER_URL=https://ftwlabs.ai/api/studio \
VITE_STUDIO_CONFIRM_PIN=4202 \
npx vite build --base=/app/
```

⚠️ Anything in a `VITE_` variable is **baked into the client bundle and
readable by anyone**. That's acceptable for the confirmation code (it isn't a
security boundary) and for the worker URL. Never put a real secret there.

---

## API

All endpoints require a valid Access JWT (`Cf-Access-Jwt-Assertion`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/upload` | Body is the raw image. Headers: `Content-Type` (png/jpeg/webp), `X-Drop-Stage` (sketch\|wip\|final), `X-Drop-Filename`. Returns `{key, stage, bytes, contentType, url}` |
| `GET` | `/f/:key` | Serves a stored file with a forced safe content type |
| `GET` | `/whoami` | Returns the signed-in identity |
| `POST` | `/queue/:id/publish` | Publish (or re-publish) one item **now**, skipping the countdown. Takes the identical path the cron takes, holds included |
| `GET` | `/etsy/status` | What's configured, whether Etsy is connected, which shop. Never returns tokens |
| `GET` | `/etsy/connect` | Starts the Etsy OAuth handshake |
| `GET` | `/etsy/callback` | **The one endpoint outside Access** — see below |

> Paths are shown relative. Behind the `ftwlabs.ai/api/studio/*` route the real
> URL is `https://ftwlabs.ai/api/studio/upload` and so on. A Workers route does
> not strip its own prefix, so the Worker normalises it internally.

Objects carry `customMetadata`: `stage`, `uploadedBy`, `uploadedAt`, and
`publishEligible` — which is `"true"` only for Final. **The publish pipeline
must read `publishEligible`**, never infer readiness from the file itself; a
half-coloured drawing is indistinguishable from a finished one to a model.

---

## Housekeeping

- **Rotate credentials that have been shown on screen.** Anything visible in a
  screenshot or shared in chat should be regenerated — Etsy keystrings and R2
  tokens included.
- The confirmation code is not a secret and doesn't need rotating; it isn't
  protecting anything.

## Auto-deploy

A piece marked **Final** enters the review queue with a grace window
(`PUBLISH_WINDOW_MINUTES`, default **120**). Leave it alone and it publishes
itself. Edit it and the clock restarts. Edit it *after* it's live and it
re-publishes in place rather than creating a duplicate.

The countdown runs in a **Cloudflare Cron Trigger**, every 5 minutes — not in
the browser. A timer that only ticks in an open tab stops exactly when you're
away, which is the whole scenario this exists for.

### Hold conditions override the timer

Auto-deploy is for the ordinary case. Any of these pins a piece to `held`
until you deal with it, no matter how long the clock has run:

- Margin below your floor (default 21%) — the reason pricing is automated at
  all is to never ship at a loss
- Missing or implausibly short title / description
- No price set
- Stage isn't Final

Holds are re-evaluated **at fire time**, not just when queued — a stale "safe"
verdict is how a bad listing slips out.

### Setup

```bash
npx wrangler d1 create ftw-studio-queue     # paste database_id into wrangler.toml
npx wrangler d1 execute ftw-studio-queue --file=./schema.sql --remote
```

`PUBLISH_ENABLED` must be exactly `"true"` for the cron to publish anything.
It ships **off**.

## Storefront — Etsy

### Why Etsy and not Printful

The intuitive design is "push the product to Printful and let Printful put it
on Etsy." That is not available. Printful's Products API is documented as
operating only on a store using the **Manual order / API** platform — a
Printful store connected to Etsy is an integration-platform store, so
`POST /store/products` cannot create listings on it. Printful states the
general case plainly: the Products API "is not intended and will never support
creating and managing products in external platforms."

So the listing is created directly through Etsy's Open API v3. Shopify remains
unavailable (`operation_not_allowed`, a billing/plan state) and is not needed.

### The fulfilment gap — read this before turning publishing on

A listing created through Etsy's API has **no link to a Printful sync product**.
When it sells, Printful will not auto-fulfil it. The order still reaches
Printful through the Etsy order sync, but unmatched: for the first order of
each design you pick the blank and the print file by hand.

No API closes this, because the API that would is the one Printful restricts to
manual stores. Your options are to match each new design once by hand, or to
create products in Printful's dashboard and let it push the listings — which
gives up the automation this pipeline exists for.

### Etsy setup

1. **Create an app** at etsy.com/developers. Note the keystring (a public
   identifier, not a secret).
2. **Register the redirect URI** on the app, exactly:
   `https://ftwlabs.ai/api/studio/etsy/callback`
3. **Pick a taxonomy id.** Etsy requires a category on every listing. Browse
   `GET /v3/application/seller-taxonomy/nodes` (no auth needed) and set
   `ETSY_TAXONOMY_ID`.
4. **Fill the `[vars]`** in `wrangler.toml` — none of them are secrets. The
   OAuth flow is PKCE, which exists precisely for clients that cannot hold one.
5. **Bind the KV namespace.** Reuse the existing `ETSY_STORE` namespace; a KV
   namespace can be bound to more than one Worker, so nothing needs migrating.
6. **Deploy, then visit `/api/studio/etsy/connect`** and approve. The Review
   Queue shows the shop id once it works.

### The callback has to sit outside Access

Etsy redirects a browser back to `/etsy/callback`, and a redirect cannot carry
a Cloudflare Access login — so that one path must be reachable without one. In
Zero Trust, add a **second** application for the exact path
`api/studio/etsy/callback` with a policy of **Bypass → Everyone**. The more
specific path wins, and everything else stays gated.

What keeps that endpoint safe is the `state` parameter: it is minted only by
`/etsy/connect`, which *is* behind Access; it is single-use; and it expires in
ten minutes. Without a matching state nothing is written, so a stranger walking
the callback cannot plant their own Etsy token in your KV.

> This is the narrow, correct version of "turn Access off for the callback."
> It does not extend to `/upload` — an ungated upload endpoint is an open
> bucket for anyone who finds the URL.

### What publishing actually does

Three calls, in an order that is not arbitrary. Etsy's spec on
`updateListing.state`: *"Setting a `draft` listing to `active` will also
publish the listing on etsy.com and requires that the listing have an image
set."* Activating before the image lands therefore fails.

1. `POST /shops/{shop_id}/listings` — create the draft
   (**`application/x-www-form-urlencoded`, not JSON** — the easiest way to earn
   a 400 on the first real run)
2. `POST .../listings/{id}/images` — attach the artwork from R2 (multipart)
3. `PATCH .../listings/{id}` with `state=active` — take it live

Every field, enum, method and content type in the adapter was read out of
Etsy's published OpenAPI document rather than from prose docs, and
`worker/test/` asserts the outgoing requests against a trimmed copy of that
spec. Run them with `npm test` in `worker/`.

### Editing a listing that is already live

`updateListing` accepts title, description and tags. It does **not** accept
price or quantity — those sit behind `updateListingInventory`, which requires
reading the whole inventory structure back, stripping its read-only fields and
PUTting it in full. That is not implemented.

A price change on a live listing therefore **fails loudly** rather than
silently not applying. An edit that looks saved but never reaches the
storefront is how you end up selling at the old price without knowing.

### Turning it on

`PUBLISH_ENABLED` ships `"false"` on purpose. The adapter is wired, but
flipping the switch before you have published one listing by hand means the
first unattended run is also the first test — against a real storefront, at
Etsy's $0.20 per listing.

Use **Publish now** on a single piece, confirm it looks right on Etsy, then set
`PUBLISH_ENABLED = "true"`.

### Etsy obligations that are yours, not the code's

- `who_made` defaults to `i_did`, which is correct when you drew the art. It is
  a policy declaration, not a formality.
- Etsy separately requires print-on-demand sellers to **declare a production
  partner** on their listings. The API does not do this for you.

## Not built yet

- Variant generation and rating
- Signature/watermarking as a pipeline step
- Drafting the copy itself. This is now the binding gap: nothing writes a
  title, description or price, so every piece lands in the queue and is
  *correctly* held for missing copy. Publishing works; there is just nothing
  to publish until you type it or something generates it.
- `updateListingInventory`, so a price edit can reach a live listing
- Linking a listing back to a Printful sync product (see the fulfilment gap
  above — no API currently allows it)
