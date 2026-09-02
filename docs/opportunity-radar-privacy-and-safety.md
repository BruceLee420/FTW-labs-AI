# Opportunity Radar — privacy and safety

This document states what the feature will and will not do, where data lives,
and which controls enforce it. Every claim here maps to code in
[`opportunity-radar/src`](../opportunity-radar/src) and to tests in
[`opportunity-radar/test`](../opportunity-radar/test).

## No automatic applications, messages or uploads

Opportunity Radar is **not an auto-apply bot**. There is no code path that:

- submits an application form,
- uploads a résumé or any file to a third party,
- sends an email, chat message, or platform message,
- logs in to, scrapes, or automates LinkedIn or any site that prohibits it.

What it does instead: it prepares material for **you** to review, edit and
approve, then shows the official application URL and a checklist. You submit
outside the system and record the result. Follow-up emails are *drafted* and
displayed; they are never sent. This is enforced structurally — the service
has no mail transport, no browser automation, and its outbound HTTP client
only performs `GET`/`HEAD` requests (see `security/ssrf.ts`).

Why: automated submission is against most platforms' terms, produces
low-quality applications, and risks sending fabricated claims under your
name. A human approval step is the product, not a limitation.

## AI is advisory

Every model output is labelled **"Advisory — review before acting."** in the
UI and stored with the prompt version, model name and timestamp
(`evaluations` table, `application_drafts` table).

- Deterministic rules run first and are always shown with their evidence.
  A model can raise the scam-risk score but cannot lower it below the rules'
  result.
- Model JSON is validated against strict schemas (`schemas/ai.ts`); invalid
  output is repaired once, then rejected. Nothing from a rejected response is
  stored.
- Verification wording is always graded — "likely legitimate", "needs manual
  verification", "high risk" — never "safe".
- Drafts are grounded only in the selected résumé profile. The prompt forbids
  inventing employers, titles, dates, degrees, certifications, metrics, work
  authorisation or portfolio items, and every draft carries an **evidence
  panel** pairing each claim with the résumé fact it came from. A grounding
  check marks claims whose source fact cannot be found in the résumé text;
  those show in red and in `groundingWarnings`.

## Where your data lives

| Data | Location | Committed to Git? | Sent anywhere? |
|---|---|---|---|
| Résumé files | Your folder (`OPPORTUNITY_RADAR_RESUMES_DIR`, default `opportunity-radar/private/resumes/source`) | **Never** (ignored) | Never. Read locally only. |
| Extracted résumé text and profiles | Local SQLite (`opportunity-radar/data/*.sqlite`) | **Never** (ignored) | To your **local** Ollama only, bounded: candidate summaries for evaluation, one profile's facts plus a ≤ 6000-character excerpt for drafting. |
| Opportunities, evaluations, drafts, audit trail | Local SQLite | Never | No |
| Listing text you ingest | Local SQLite | Never | Sent to local Ollama for evaluation (≤ 8000 characters) |
| Generated files you export | `opportunity-radar/private/output` | Never | No |
| `.env` | Local | Never (`.env.example` only) | No |

The browser only ever receives résumé **metadata** (filename relative to the
folder, label, tags, extraction status and quality, counts). Absolute paths
and extracted text are excluded by the API projection, and
`npm run lint` fails if route code references `extractedText` directly.

Logs contain ids, counts and error names — never résumé text or prompt
bodies.

## Security controls

| Threat | Control |
|---|---|
| Someone on your network calling the API | Binds to `127.0.0.1` by default; refuses to bind elsewhere unless `OPPORTUNITY_RADAR_AUTH_TOKEN` is set (bearer token, constant-time compare). `AuthGuard` interface allows a Cloudflare Access verifier later. |
| DNS rebinding from a hostile page | `Host` header must be loopback or an allow-listed origin host; otherwise `421`. |
| Cross-site requests from other pages | CORS grants only to `OPPORTUNITY_RADAR_ALLOWED_ORIGINS`; mutating requests must carry `X-Radar-Request` (forces a preflight). |
| SSRF through "paste a URL" | Scheme allowlist, no credentials in URLs, IP-literal and DNS-resolved checks against private/loopback/link-local/multicast/reserved ranges (IPv4 and IPv6 incl. mapped forms), every redirect re-validated, 5-redirect cap, byte cap, timeout, content-type check. Residual risk: DNS answers can change between check and connect; the byte/time caps bound the impact. |
| Abusing the service as a scraper | Built-in denylist of platforms that prohibit automation, `robots.txt` honoured, login walls and CAPTCHAs are detected and stop ingestion, no retries, one page per request, identifying `User-Agent`. |
| Request floods | Token-bucket rate limits per client (general and "expensive" buckets). |
| Injection | Every request body and query is parsed by zod schemas; SQL uses prepared statements with an allow-listed sort map; HTML in the UI is escaped; CSV cells are formula-guarded. |
| Information leaks in errors | Clients receive generic messages; details go to the local log. |
| Hostile listing content | Listing text is data: it is stored, displayed escaped, and passed to the model inside a clearly delimited section with instructions to treat it as untrusted. |

## Data retention and deletion

Nothing expires automatically; you own the retention policy.

- Delete one opportunity: `DELETE /api/opportunity-radar/opportunities/:id`
  (cascades to sources, evaluations, application, drafts, follow-ups).
- Delete one résumé index entry: `DELETE /api/opportunity-radar/resumes/:id`
  (the file in your folder is untouched).
- Delete everything: Settings → *Delete all data* →
  `POST /api/opportunity-radar/data/purge` with `{"confirm":"DELETE EVERYTHING"}`
  (scope `all`, `opportunities`, `resumes` or `drafts`). Audit events for the
  purge itself are the only rows written afterwards.
- Nuclear option: stop the service and delete `opportunity-radar/data/`.

Backups: Settings → *Export JSON* produces a single file you can store or
re-import.

## What we ask of you

- Keep your résumé folder outside any synced or shared path you would not
  want indexed, and never commit `private/` or `data/`.
- Treat every score as a starting point. Verify the employer through its
  official site before applying, especially when the status is anything
  other than "verified official source".
- Read every draft before approving it. Approval is an explicit, logged
  action and you are the author of what gets submitted.
