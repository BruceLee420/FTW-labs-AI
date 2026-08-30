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

## Known blocker — storefront publishing

`queue.ts:publishToStore` is a stub, and `PUBLISH_ENABLED` is `false`.

The connected Shopify store currently returns `operation_not_allowed` —
*"This shop is unavailable for API access. The merchant may need to resolve a
billing issue or upgrade their plan."* With the store unreachable there's no
way to observe a real `productCreate` request/response, and shipping a guessed
mutation would mean the first live run is also the first test.

Everything upstream is real and working: drop, queue, edits, holds, timer,
re-publish. To finish: restore store API access → read the `ProductInput`
schema → verify against a draft product → implement `publishToStore` → set
`PUBLISH_ENABLED = "true"`.

## Not built yet

- Variant generation and rating
- Signature/watermarking as a pipeline step
- Drafting the copy itself (the queue accepts and edits it; generation is
  still to come)
