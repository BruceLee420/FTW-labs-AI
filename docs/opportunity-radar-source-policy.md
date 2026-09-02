# Opportunity Radar — permitted source policy

Opportunity Radar only ingests from sources whose owners permit it. The
policy is enforced in code (`security/denylist.ts`, `security/ssrf.ts`,
`adapters/`), not just written down.

## Allowed

| Source | How | Why it is permitted |
|---|---|---|
| **Official company career pages** | Paste the URL. One `GET`, `robots.txt` honoured, JSON-LD `JobPosting` parsed when present. | Public pages published by the employer for candidates. |
| **Public ATS job-board APIs** — Greenhouse today (`adapters/greenhouse.ts`) | Sources panel → Greenhouse → board token. | Greenhouse's Job Board API is a documented, credential-free feed intended for third-party display. Lever, Ashby and similar public endpoints can be added behind the same `AtsAdapter` interface. |
| **Hosted ATS listing pages** (boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, …) | Paste the URL. | Public listing pages; recognised as a positive legitimacy signal. |
| **RSS / Atom feeds** you are permitted to read | Sources panel → RSS → feed URL. | Feeds are published for syndication. Only add feeds whose terms allow it. |
| **Manual entry and JSON/CSV import** | UI form, `POST …/opportunities/manual`, `…/import`, CSV import in Settings. | You are the source. Use this for referrals, emails, and anything behind a login. |
| **Mock adapter** | Sources panel → Mock → `sample`. | Synthetic data for demos and tests. |

## Refused

The URL ingester refuses these hosts (and their subdomains) with a message
telling you to use the employer's own page or enter details manually:

- `linkedin.com`, `licdn.com` — LinkedIn's User Agreement prohibits
  automated access and scraping. **No LinkedIn scraping or automation is
  implemented and none will be.**
- `indeed.com`, `glassdoor.com`, `ziprecruiter.com` — terms prohibit
  automated access.
- `facebook.com`, `instagram.com`, `x.com`, `twitter.com` — same.
- Cloud metadata endpoints and every private, loopback, link-local and
  reserved IP range (SSRF protection, see privacy and safety).

Add your own with `OPPORTUNITY_RADAR_URL_DENYLIST`.

## How fetching behaves

- Only `GET` and `HEAD`. Never `POST`. Never logs in, never fills forms.
- Identifies itself: `User-Agent: FTWOpportunityRadar/0.1 (+https://ftwlabs.ai)`.
- Fetches `robots.txt` once per origin and obeys `Disallow`/`Allow` for `*`
  and for its own agent name. A disallowed path is refused, not retried.
- Stops at login walls and CAPTCHA challenges (HTTP 401/403 or challenge
  markers in the body). A stub opportunity is created so you can fill in the
  details manually; nothing tries to bypass the wall.
- Does not follow more than five redirects, read more than 2 MB, or wait more
  than 15 seconds (all configurable downward).
- One request per user action. There is no crawler, scheduler, or
  background polling of third-party sites. Source syncs run only when you
  click *Sync*.

## Adding a new source adapter

1. Confirm the source publishes a public, documented feed or API that permits
   third-party use without credentials, or that you hold explicit permission.
2. Implement `AtsAdapter` from `src/adapters/types.ts`: `id`, `displayName`,
   `policyNote` (cite the permission), `targetHint`, `validateTarget`, and
   `fetch(target, ctx)` using `ctx.fetcher` (the SSRF-safe client) and
   returning `ManualOpportunityInput` items. Never write to the database from
   an adapter.
3. Register it in `src/adapters/registry.ts` and add fixture-based tests in
   `test/adapters.test.ts` (no network in tests).
4. Document it in the table above with the reason it is permitted.

Adapters that would require a login, a browser, CAPTCHA solving, or
rate-limit evasion will not be accepted.
