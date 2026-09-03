# Opportunity Radar — implementation plan

Status: implemented in `opportunity-radar/` (phase one). This document records
what the repository looked like before the feature was added, the decisions
that shaped it, and where each piece lives. Companion docs:
[setup](opportunity-radar-setup.md),
[privacy and safety](opportunity-radar-privacy-and-safety.md),
[source policy](opportunity-radar-source-policy.md).

## Phase 0 — what the repository actually is

| Area | Finding |
|---|---|
| Framework | **None at the root.** `index.html` is a hand-written static landing page (inline CSS + vanilla JS, no build step). `app/` is a *committed Vite build* of a separate repo (TrendForge); its React source is not here. |
| Backend | `worker/` — a Cloudflare Worker (TypeScript 5, `jose`, D1/R2/KV, `wrangler`). Auth is Cloudflare Access JWTs. Tests are plain `node` scripts using `node:assert` after an `esbuild` bundle. |
| Runtime | Node 22 (`.github/workflows/daily-signal.yml` pins 22; the container runs 22.22). Node 22 ships `node:sqlite`, native TypeScript type stripping, and `zlib.crc32`. |
| Styling | No Tailwind. Design tokens live in `index.html` (`--paper`, `--ink`, `--hot`, `--gold`, `--teal`, `--line`; IBM Plex Sans/Mono + Big Shoulders Display; crop-mark dividers; `.btn` / `.btn-ghost`). Light/dark via `prefers-color-scheme` and `data-theme`. |
| Routing | GitHub Pages serves the repo as-is. The Worker is routed at `ftwlabs.ai/api/studio/*`. |
| Env pattern | Worker uses `wrangler.toml` `[vars]`; `scripts/fetch-signals.mjs` reads `process.env`. No `.env.example` existed. |
| Testing | Hand-rolled `ok()` counters + `node:assert/strict`, run by `npm test` inside `worker/`. No root test runner. |
| Lint | No ESLint/Prettier anywhere. `typecheck` = `tsc --noEmit`. |
| Docker | None. |
| Dashboard | The "dashboard" is the site itself: `index.html` (landing/pitch) and `/app/` (TrendForge). `app/index.html` already carries one hand-mounted fixed-position element (the back-link banner) outside the React build — the precedent for mounting a corner widget. |
| `.gitignore` | Only `.DS_Store`, `*.log`, `node_modules/`. Nothing about private data or databases. |

## Decisions (and deviations from the brief)

1. **Standalone local service, not the Worker.** The brief says to integrate with an
   existing backend when one exists. The existing backend is a Cloudflare Worker at
   the edge: it cannot read a résumé folder on the user's disk or reach
   `http://localhost:11434` (Ollama). A local-first feature therefore has to run on the
   user's machine. Opportunity Radar is a Node 22 + TypeScript HTTP service in
   `opportunity-radar/`, laid out like `worker/` (its own `package.json`, `tsconfig`,
   tests), so it can be extracted into its own repo unchanged.
2. **No new framework.** The repo has no React/Next source, so the UI is server-served
   static HTML + vanilla JS that reuses the landing page's design tokens. The brief's
   `components/`, `hooks/` folders map to `public/` (pages, `radar.js`, `widget.js`).
3. **Persistence: SQLite through `node:sqlite`.** No native module to compile. Access
   goes through repository interfaces (`src/repositories/interfaces.ts`) so Postgres or
   D1 can replace it. Migrations are numbered SQL files applied by `src/db/migrate.ts`.
4. **Dependencies added (runtime): `zod` (schemas for every request and every model
   output) and `unpdf` (PDF text extraction; pdf.js under the hood, no worker/canvas).**
   DOCX is parsed by a small built-in ZIP + `document.xml` reader. Dev: `typescript`,
   `esbuild`, `@types/node`. No Python.
5. **Auth.** The Worker's Cloudflare Access model does not apply on localhost. The
   service binds to `127.0.0.1` by default, refuses to bind a non-loopback host unless
   `OPPORTUNITY_RADAR_AUTH_TOKEN` is set, checks the `Host` header (DNS-rebinding),
   restricts CORS to an allowlist, requires a custom header on mutating requests (forces
   a preflight), and rate-limits per client. An `AuthGuard` interface exists so a
   Cloudflare Access verifier can be dropped in if this ever moves behind the Worker.
6. **AI provider.** `ollama` by default with an American open-weights model
   (`llama3.1`) as the default `OLLAMA_MODEL`; `none` disables AI entirely. No paid API.
   All output is validated with zod; one repair retry on invalid JSON.
7. **Lint.** No linter exists in the repo; `npm run lint` = strict `tsc` plus a privacy
   guard script that fails if private paths are not ignored or tracked files contain
   résumé/database artifacts.
8. **Tests** use `node --test` with native TypeScript type stripping (Node ≥ 22.18), in
   the same spirit as `worker/` (built-in runner, `node:assert/strict`, no framework).

## Module map (`opportunity-radar/`)

```
package.json / tsconfig.json / .env.example / .gitignore
scripts/check-privacy.mjs         lint guard for private data
src/
  server.ts                       entry: config → db → migrate → listen
  app.ts                          createApp(deps): request handler (testable, no listen)
  config.ts                       env parsing with zod; safe (path-free) summary
  types/entities.ts               Opportunity, ResumeProfile, Application, Draft,
                                  FollowUpTask, SourceSyncRun, AuditEvent, Evaluation
  schemas/                        zod: enums, API bodies, AI outputs, imports
  db/client.ts, migrate.ts, migrations/*.sql
  repositories/interfaces.ts      repository contracts
  repositories/sqlite/*.ts        SQLite implementations
  utils/                          ids, hashing, text normalisation, csv, url, html
  security/ssrf.ts                URL validation, DNS checks, safe fetch
  security/auth.ts, rateLimit.ts
  rules/                          deterministic scam, geography, work mode, comp,
                                  employment type, legitimacy scoring
  services/                       normalize, dedupe, ingest/*, evaluate, resumeMatch,
                                  drafts, applications, followUps, export, data,
                                  resumes/indexer + profile
  parsers/                        pdf, docx (+zip), text/markdown, quality
  adapters/                       AtsAdapter interface, greenhouse (public board API),
                                  mock (fixtures), rss
  ai/                             AiProvider, ollama, none, json repair loop
  prompts/                        versioned prompt builders
  http/                           router, responses, cors, static, routes/*
public/                           radar.css, radar.js, index.html, resumes.html,
                                  settings.html, widget.js
test/                             node:test suites + fixtures (synthetic data only)
```

## Entities

Opportunity, OpportunitySource (evidence rows for dedup), Evaluation (rules + AI,
versioned), ResumeProfile, Application, ApplicationDraft (versioned), FollowUpTask,
SourceSyncRun, AuditEvent. Field lists are in `src/types/entities.ts`; the CSV export
columns are in `src/services/export.ts`.

## Workflow states

| Status | Set when |
|---|---|
| `NORMALIZED` | Created (manual, URL, import, sync); description sectioned, skills/work mode/geography/compensation inferred. |
| `VERIFIED` / `REVIEW_NEEDED` | After evaluation: rules (+ advisory model) yield `VERIFIED_OFFICIAL_SOURCE`/`LIKELY_LEGIT`, or anything weaker. |
| `DRAFT_PREPARED` | A draft package exists (model or template); the application row is `AWAITING_APPROVAL`. |
| `AWAITING_APPROVAL` | Reserved for the user's own "in review" marker via the status control. |
| `READY_TO_APPLY` | The user clicked **Approve for application**; the official URL and checklist unlock. |
| `APPLIED` | The user recorded a submission they made themselves; a follow-up task is created (default 7 days). |
| `FOLLOW_UP_DUE` | Promoted automatically when the follow-up date passes (on list/summary refresh). |
| `FOLLOWED_UP` | The user marked the follow-up as sent (the email was drafted, never sent). |
| `INTERVIEWING`, `OFFER`, `REJECTED`, `SKIPPED`, `CLOSED` | Manual status changes; `REJECTED` on a `HIGH_RISK` listing also sets `REJECTED_AS_SCAM`. |

Every transition is written to `audit_events`.

## Deduplication

`services/dedupe.ts` asks the repository for candidates matched on any indexed key and
ranks them: canonical URL or (source, external id) → **exact**; identical description hash
for the **same company** → **strong**; same normalised company + title with compatible
work mode and location → **probable**. A duplicate never creates a new row: the sighting is
appended to `opportunity_sources`, missing URLs/dates are backfilled, and an audit event
records what matched.

Hard rules enforced in code, not just documented:

- `mark-applied` fails with 409 unless the application was explicitly approved.
- No code path submits, uploads, emails, or messages anything. Drafts are stored and
  displayed only.
- Résumé text never leaves the server: list/detail responses expose metadata only.
- URL ingestion refuses private/loopback/link-local targets, denylisted platforms
  (LinkedIn and others that forbid automation), oversized bodies, and long redirect
  chains; it honours `robots.txt` and stops at login walls.

## Site integration

- `index.html` and `app/index.html` load `/opportunity-radar/public/widget.js`. The
  widget probes the local service; when it is not running it stays hidden on the
  public site (nothing changes for visitors) and shows an "offline" state only on
  localhost.
- Root `.gitignore` ignores `opportunity-radar/private/`, `opportunity-radar/data/`,
  `opportunity-radar/dist/` and `.env*`.

## Known limitations (phase one)

- Résumé profiling is heuristic: skills come from a curated dictionary, so an
  unusual tool is missed until the dictionary grows; certification and degree
  regexes stop at dashes and can tag "Associate" in a certification name as a
  degree-like fact. The evidence panel still shows the exact text, so nothing
  is claimed silently.
- `POOR`/`NEEDS_OCR` thresholds are character-count heuristics tuned for
  one-to-three page résumés; very short deliberately minimal résumés may be
  marked `POOR`.
- The keyword retriever ignores synonyms ("PM" vs "Product Manager"); the
  `ResumeRetriever` seam exists for a vector retriever.
- Rule weights are fixed constants; there is no per-user tuning UI yet.
- URL ingestion reads one page per action and cannot see listings rendered
  purely by client-side JavaScript without JSON-LD or meta tags; use manual
  entry for those.

## Phase two (not in this change)

Vector retrieval behind `ResumeRetriever`; OCR for `NEEDS_OCR` files; additional ATS
adapters (Lever, Ashby) through the same interface; scheduled source syncs; Cloudflare
Access guard if the service is ever hosted; richer calendar/ICS export for follow-ups.
