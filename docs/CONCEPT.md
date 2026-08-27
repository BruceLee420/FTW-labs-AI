# FTW Labs AI — Concept

Status: **pre-launch concept**, authored by Claude at Adrian Grimaldo's request
("pilot our greatest idea"). Nothing below is a committed roadmap — it's a
proposal grounded in infrastructure that already exists and runs today.

## One paragraph

FTW Labs AI turns real search, video, and sales demand into print-on-demand
drops — matched against real Printify/Printful catalog availability and
priced against a hard profit floor — before a design is finalized or a
dollar is spent on inventory. It's not a new idea built from nothing: it's
the productization of a toolchain that already exists across three separate
projects in this account.

## The problem

Independent POD sellers and artists making the jump to merch typically:

- Pick designs by vibes, Pinterest scrolling, or copying what a competitor
  posted — no evidence a niche actually has demand.
- Price by gut, then discover the margin evaporated after platform fees,
  provider cost, and shipping.
- Design for a color/size combination the fulfillment provider doesn't
  actually stock, or that fits their catalog worse than an alternative
  would have.
- Keep no record of *why* a decision got made, so nothing compounds —
  every drop starts from zero again.

## The solution: four stages, already real

| Stage | What it does | What already exists for it |
|---|---|---|
| 01 SIGNAL | Score search/video/purchase demand with sources and confidence, never an unqualified claim | **TrendForge POD Intelligence** (this account's trend-intelligence dashboard) — CSV/XLSX ingestion, evidence-weighted opportunity scoring, already built and running |
| 02 DESIGN | Turn a validated niche into an AI-assisted design concept | **FreeThinkers.AI** — a live daily AI-art practice (Adrian Grimaldo / VoxMOHAWK), proof the design engine works, not a theoretical capability |
| 03 FULFILL | Check the concept against real provider catalog data | TrendForge's Provider Catalog page (Printify/Printful variant matching) — built |
| 04 DROP | Price against a hard profit floor, publish, track | **studio-drop** — the existing Google Drive → Printful → Shopify pipeline with a 21%-minimum-margin profit floor and a price-decision log |

FTW Labs AI's actual job is narrower than it sounds: **connect stages that
already work but currently live in separate tools**, and make the hand-off
between them evidence-based instead of manual guesswork. TrendForge's
Monetize page already has a "send to studio-drop" brief generator as the
first concrete piece of that connective tissue.

## Who it's for

Two possible audiences — deliberately not chosen yet:

1. **Internal use only.** FTW Labs AI stays a private toolchain that powers
   FreeThinkers.AI's own merch drops. No external product, no pricing, no
   support burden. Lowest risk, fastest to real revenue (direct POD
   margin), and the only way to generate the track record needed for #2.
2. **A product for other creators/POD sellers.** Package the pipeline as a
   tool or service other people pay for. Real market, but real cost:
   support, onboarding, a defensible reason to trust the scores, and
   competitors already operating in the "POD trend tool" space that this
   project has **not yet researched** (see Open Questions).

**Recommendation:** start at #1. Prove the economics on real drops first —
"here's what this pipeline generated for our own store" is a far stronger
pitch than a concept page, and it's the only path that doesn't require
guessing at a market before touching it.

## Business model options (not decided)

| Model | Mechanics | Fit |
|---|---|---|
| Direct POD margin | Sell merch made through the pipeline; margin = retail − provider cost − fees | Real today, zero new infrastructure, the honest starting point |
| Managed service | "We run your drops for a cut" — high-touch, few customers | Plausible only after #1 proves the pipeline reliably picks winners |
| B2B SaaS | License Opportunity Lab-style briefs to other sellers, subscription | Needs a real backend, auth, billing — none of which exist yet (see TrendForge's own build status) |
| White-label licensing | License the pipeline to a POD platform or agency | Furthest out — would need a track record and legal/IP groundwork not started |

## Open questions — genuinely unresolved, not glossed over

- **The name and domain.** `ftwlabs.ai` is unregistered as of this
  research (returns HTTP 404, no public company found under that name).
  Before any public-facing launch, confirm the domain is actually
  available and register it, or pick a different name.
- **Competitive landscape.** This document has *not* done a competitive
  scan of existing POD trend-research or automation tools. That's a real
  gap to close before pitching this externally — don't assume a clear
  field without checking.
- **Pricing.** Nothing below is committed. The landing page frames early
  access as a "Founding Run" specifically to avoid presenting invented
  price tiers as real.
- **Legal/IP.** AI-generated design concepts sold as merch carry
  copyright and platform-policy considerations (Printify/Printful/Etsy
  AI-content policies) that haven't been reviewed here.

## Immediate next steps

1. Decide internal-only vs. external product (see Who it's for) — this
   determines almost everything else.
2. If committing to the brand: check and register `ftwlabs.ai` (or a
   fallback domain).
3. Run TrendForge's existing "send to studio-drop" hand-off on a real
   opportunity and track what it actually produces — the first real data
   point for this whole concept.
4. Only after step 3 has real numbers: revisit whether an external
   product is worth building, and do the competitive research this
   document explicitly skipped.

## Relationship to this repository

This repo (`ftw-labs-ai`) currently holds the concept pitch only: this
document and the landing page (`index.html`). It intentionally does not
yet contain a product build — per the venture's own next steps above, that
comes after step 3, not before.
