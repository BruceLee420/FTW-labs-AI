# FTW Labs AI

**Status: one real stage live, the rest still a pitch.** Stage 01 (SIGNAL)
is a working app, not a mockup — see [`app/`](app/) below. Stages 02-04 are
still concept only. See [`docs/CONCEPT.md`](docs/CONCEPT.md) for the full
thinking, including what's genuinely unresolved (pricing, competitive
research not yet done).

**Live at:** [ftwlabs.ai](https://ftwlabs.ai) (once DNS finishes
propagating — see below) and
[brucelee420.github.io/FTW-labs-AI](https://brucelee420.github.io/FTW-labs-AI/)
in the meantime.

## What this is

FTW Labs AI turns real search, video, and sales demand into print-on-demand
drops — matched against real Printify/Printful catalog availability and
priced against a hard profit floor — before a design is finalized or a
dollar is spent on inventory.

It isn't a concept invented from nothing. It's the productization of
infrastructure that already exists across three projects in this account:

- **TrendForge POD Intelligence** — evidence-scored trend intelligence
  (search/video/purchase demand → opportunity scoring → provider catalog
  matching).
- **FreeThinkers.AI** — a live daily AI-art practice (Adrian Grimaldo /
  VoxMOHAWK) that proves the design-generation half of this works.
- **studio-drop** — an existing Google Drive → Printful → Shopify pipeline
  with a hard profit-floor and a price-decision log.

FTW Labs AI's job is connecting those stages with real evidence, not
manual guesswork, at the hand-off points between them.

## What's here

- [`index.html`](index.html) — the landing page. Open it directly in a
  browser, or serve it statically (GitHub Pages, Netlify, Vercel — no
  build step, no dependencies).
- [`app/`](app/) — **the actual Stage 01 (SIGNAL) app, live and working**:
  a built copy of [TrendForge POD
  Intelligence](https://github.com/BruceLee420/everydays-inspiration-node) —
  real CSV/XLSX import, real filtering, real evidence-weighted opportunity
  scoring, real Printify/Printful catalog matching. Served at
  `ftwlabs.ai/app/`. It's a static build (`vite build --base=/app/`)
  committed as built output, not source — the source lives in the
  TrendForge repo linked above. **To update it:** rebuild TrendForge with
  `npx vite build --base=/app/`, copy `dist/*` over this folder, and
  reapply the small back-link banner this folder's `index.html` has at
  the top of `<body>` and the Opportunity Radar widget `<script>` tag at the
  bottom of `<body>` (a plain fixed-position `<a>` tag, not part of the
  React build — diff against git history if it gets clobbered by a raw
  copy).
- [`docs/CONCEPT.md`](docs/CONCEPT.md) — the full concept: problem,
  solution, audience, business model options, and honestly-flagged open
  questions.
- [`opportunity-radar/`](opportunity-radar/) — **Opportunity Radar**, a
  local-first, human-approved assistant for finding, verifying, matching and
  tracking remote jobs and other professional opportunities. Runs on your
  machine (Node 22 + SQLite + local Ollama), indexes résumés from a private
  folder, scores listings with explainable rules plus advisory AI, drafts
  grounded application packages, and never submits anything on your behalf.
  It mounts as the compact corner widget on this dashboard when the service
  is running. Docs: [setup](docs/opportunity-radar-setup.md),
  [privacy and safety](docs/opportunity-radar-privacy-and-safety.md),
  [source policy](docs/opportunity-radar-source-policy.md),
  [implementation plan](docs/opportunity-radar-implementation-plan.md).

## About the "signal count" on the landing page

The page includes a live interest counter. It's real — no email
collection, just an anonymous shared count — but it only *syncs across
viewers* when served through a Claude Artifact (it uses that platform's
publish capability to persist state). Opened as a plain static file or
deployed elsewhere, the button still works but falls back to a per-device
local tally, and says so on click. This is a deliberate degrade, not a bug:
see the comments in `index.html`'s script for why collecting real emails
into the page's own published HTML was avoided (anyone who can view the
page could otherwise read them out of its source).

## Custom domain (ftwlabs.ai, on Cloudflare)

The repo includes a `CNAME` file pointing GitHub Pages at `ftwlabs.ai`.
That's only the GitHub-side half — DNS still needs to point at GitHub from
the Cloudflare side. In the Cloudflare dashboard for `ftwlabs.ai`, under
**DNS → Records**, add:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `@` | `185.199.108.153` | DNS only (grey cloud) |
| A | `@` | `185.199.109.153` | DNS only (grey cloud) |
| A | `@` | `185.199.110.153` | DNS only (grey cloud) |
| A | `@` | `185.199.111.153` | DNS only (grey cloud) |
| CNAME | `www` | `brucelee420.github.io` | DNS only (grey cloud) |

Four A records because GitHub Pages doesn't support a single apex-domain
CNAME the way a subdomain would — Cloudflare does support CNAME
flattening at the apex as an alternative (one record: `@` →
`brucelee420.github.io`), but the four A records are GitHub's own
documented method and work the same either way.

**Set proxy status to "DNS only" (grey cloud), not "Proxied" (orange
cloud), at least until GitHub finishes issuing the HTTPS certificate** —
Cloudflare's proxy can interfere with that first-time validation. Once
`https://ftwlabs.ai` loads with a valid lock icon (check GitHub's Pages
settings for a "your site is published" confirmation), it's safe to
switch back to Proxied if Cloudflare's CDN/WAF features are wanted.

After adding the records, also revisit **Settings → Pages** on this repo
and confirm "Enforce HTTPS" gets checked once it's available (GitHub
grays it out until the certificate is issued, which can take a few
minutes to a few hours after DNS propagates).

## Status

Stage 01 (SIGNAL) is a real, working app — try it at `/app/`. Stages 02-04
(DESIGN, FULFILL, DROP) are still separate, unconnected tools
(FreeThinkers.AI, TrendForge's Provider Catalog, and studio-drop
respectively) — nothing yet hands off between them automatically. No
backend, no live provider API integrations (TrendForge's own CSV import is
real; its Printify/Printful/YouTube/Shopify *live* connectors are not), no
committed pricing. See `docs/CONCEPT.md`'s "Immediate next steps" for what
comes before the rest gets built.
