# FTW Labs AI

**Status: pre-launch concept.** This repo currently holds the pitch, not a
product — see [`docs/CONCEPT.md`](docs/CONCEPT.md) for the full thinking,
including what's genuinely unresolved (name/domain, pricing, competitive
research not yet done).

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

- [`index.html`](index.html) — the concept landing page. Open it directly
  in a browser, or serve it statically (GitHub Pages, Netlify, Vercel —
  no build step, no dependencies).
- [`docs/CONCEPT.md`](docs/CONCEPT.md) — the full concept: problem,
  solution, audience, business model options, and honestly-flagged open
  questions.

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

## Status

No backend, no live provider integrations, no committed pricing. This is
the pitch stage — see `docs/CONCEPT.md`'s "Immediate next steps" for what
comes before any of that gets built.
