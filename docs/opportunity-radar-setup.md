# Opportunity Radar — setup

Opportunity Radar is a **local-first** service that lives in
[`opportunity-radar/`](../opportunity-radar/). It runs on your machine, stores
everything in a local SQLite file, reads résumés from a private folder you
choose, and talks to a local Ollama model for *advisory* analysis. It never
submits an application or sends a message. See
[privacy and safety](opportunity-radar-privacy-and-safety.md) and the
[source policy](opportunity-radar-source-policy.md).

## Requirements

- Node.js **22.18 or newer** (uses the built-in SQLite driver and native
  TypeScript type stripping; no compiler step, no native modules).
- Optional: [Ollama](https://ollama.com) for AI evaluation and drafting.
  Without it, everything except the model-generated parts still works:
  manual entry, URL ingestion, deterministic scam and eligibility rules,
  résumé indexing and matching, template drafts, tracking, exports.

## 1. Install and run

```bash
cd opportunity-radar
npm install
cp .env.example .env        # optional — every value has a safe default
npm run dev                 # or: npm start
```

The service prints its URL, by default `http://127.0.0.1:4747/opportunity-radar/`.
It binds to loopback only. The corner widget on the dashboard (`index.html`
and `/app/`) detects it automatically; visitors to the public site never see
the widget because their browsers cannot reach your machine.

Useful commands:

| Command | What it does |
|---|---|
| `npm run dev` | Start with file watching |
| `npm start` | Start once |
| `npm run migrate` | Apply pending database migrations (also runs on start) |
| `npm run index-resumes` | Index the résumé folder from the terminal |
| `npm test` | Run the test suite |
| `npm run typecheck` / `npm run lint` | Strict TypeScript + privacy guard |
| `npm run build` | Bundle to `dist/server.mjs` (optional; `npm start` runs source directly) |

## 2. Environment variables

All optional. Set them in `opportunity-radar/.env` (git-ignored; every npm
script loads it automatically through Node's `--env-file-if-exists`) or export
them in your shell.

| Variable | Default | Purpose |
|---|---|---|
| `OPPORTUNITY_RADAR_HOST` | `127.0.0.1` | Bind address. Anything other than loopback **requires** an auth token. |
| `OPPORTUNITY_RADAR_PORT` | `4747` | Port. |
| `OPPORTUNITY_RADAR_AUTH_TOKEN` | unset | When set, every API request must send `Authorization: Bearer <token>`. The UI asks once and keeps it in `sessionStorage`; the dashboard widget reads `localStorage.ftw_radar_token`. |
| `OPPORTUNITY_RADAR_ALLOWED_ORIGINS` | `https://ftwlabs.ai,http://127.0.0.1:4747,http://localhost:4747` | Browser origins allowed to call the API (CORS). |
| `OPPORTUNITY_RADAR_DB_PATH` | `./data/opportunity-radar.sqlite` | SQLite file (git-ignored). |
| `OPPORTUNITY_RADAR_RESUMES_DIR` | `./private/resumes/source` | Folder with your résumés (git-ignored). |
| `OPPORTUNITY_RADAR_OUTPUT_DIR` | `./private/output` | Where exported draft files go (git-ignored). |
| `OPPORTUNITY_RADAR_AI_PROVIDER` | `ollama` | `ollama` or `none`. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint. |
| `OLLAMA_MODEL` | `llama3.1` | Model name as shown by `ollama list`. |
| `OPPORTUNITY_RADAR_AI_TIMEOUT_SECONDS` | `90` | Per-request model timeout. |
| `OPPORTUNITY_RADAR_FOLLOW_UP_DAYS` | `7` | Default follow-up interval after "applied". |
| `OPPORTUNITY_RADAR_FETCH_MAX_BYTES` / `_MAX_REDIRECTS` / `_TIMEOUT_SECONDS` | `2000000` / `5` / `15` | URL ingestion limits. |
| `OPPORTUNITY_RADAR_URL_DENYLIST` | unset | Extra hostnames to refuse (LinkedIn and other automation-prohibiting sites are always refused). |
| `OPPORTUNITY_RADAR_GREENHOUSE_BOARDS` | unset | Greenhouse board tokens to offer in the Sources panel. |
| `OPPORTUNITY_RADAR_RSS_FEEDS` | unset | Permitted RSS/Atom feed URLs to offer in the Sources panel. |

## 3. Configure the résumé folder

1. Create the folder (the default is `opportunity-radar/private/resumes/source`)
   or point `OPPORTUNITY_RADAR_RESUMES_DIR` at an existing one.
2. Put your résumé variants there as **PDF, DOCX, TXT or Markdown**. Name
   files descriptively — the filename seeds the profile label and target
   roles, e.g. `jordan-product-manager.pdf`.
3. Open **Résumé Library** in the UI and click **Index folder** (or run
   `npm run index-resumes`). Unchanged files (same content hash) are skipped
   on later runs.
4. Review each row: extraction status, quality, the editable label, target
   role tags, and the active toggle. Only **active** profiles are considered
   for matching and drafting.

The service never returns extracted résumé text to the browser; the library
shows metadata, counts and a quality indicator only. The folder path is never
shown in the UI either — only whether it is configured and reachable.

### "NEEDS_OCR" — scanned or image-only PDFs

If a PDF yields no usable text (a scan, or a design-tool export with text as
outlines), the profile is flagged `NEEDS_OCR` and excluded from matching
rather than treated as an empty résumé. Fix by exporting a text-based PDF from
the original document, saving as DOCX/Markdown, or running OCR (for example
`ocrmypdf in.pdf out.pdf`) and re-indexing.

## 4. Install and run Ollama (optional)

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh     # or download from ollama.com
ollama serve                                       # usually starts automatically
ollama pull llama3.1                               # the default model
```

Windows: install from ollama.com; the service runs in the background.

Check the connection in **Settings → AI status** or with
`curl http://localhost:11434/api/tags`. The health endpoint
(`GET /api/opportunity-radar/health`) reports whether Ollama is reachable and
whether the configured model is pulled.

### Choosing a model

Set `OLLAMA_MODEL`. The default configuration uses open-weights models from
US-based publishers; suggested options:

| Model | Notes |
|---|---|
| `llama3.1` (8B) | Default. Good balance of JSON reliability and speed on 16 GB machines. |
| `llama3.2` (3B) | Faster, lighter; fine for evaluation, weaker for cover letters. |
| `gemma3` | Google's open model; strong writing quality. |
| `phi4` | Microsoft; compact and capable for structured output. |
| `granite3.3` | IBM; permissive licence. |

Any model that Ollama can run will work because output is validated against
strict schemas and repaired once if malformed. Models are not sent your full
résumé library — only the top matching profiles' summaries for evaluation and
one selected résumé's facts for drafting.

## 5. Add your first opportunity

- **Paste a URL**: in the widget or the Radar page, paste the listing URL and
  click *Add*. The service fetches it with SSRF protection, honours
  `robots.txt`, stops at login walls or CAPTCHAs, extracts JSON-LD
  `JobPosting` data when present, normalises the description, runs the
  deterministic rules, and (if Ollama is up) asks the model for an advisory
  evaluation.
- **Manual entry**: click *Add manually* and fill in company, title,
  description and URLs — for listings behind a login, or from a referral.
- **Import**: `POST /api/opportunity-radar/opportunities/import` with a JSON
  batch, CSV import in Settings, or a source sync (Greenhouse board, permitted
  RSS feed, or the built-in mock source for demos).

## 6. How scoring works (and its limits)

Every opportunity carries four 0–100 scores. They are **advisory**; the UI
shows the reasons behind each and the recommended next step, never a binary
"safe" label.

1. **Deterministic rules run first** (`src/rules/`). Risk signals (payment
   requests, generic webmail contacts, messaging-app-only recruiting,
   URL/domain mismatches, redirect shorteners, vague or pressured wording,
   sensitive-data requests, uncorroborated roles) and positive signals
   (official career page, public ATS listing, consistent domain, complete
   description, transparent process) each carry a weight and an evidence
   snippet. They produce legitimacy, scam-risk and remote-eligibility scores
   and a verification status.
2. **Résumé matching** is deterministic keyword/skill overlap between the
   listing and each active profile; the top 2–3 become candidates.
3. **The model (if available)** receives the listing, the rule findings and
   the candidate summaries, and returns validated JSON: its own scores, a
   rationale, evidence quotes, risk signals, missing information, the best
   résumé id and a suggested action. Stored with prompt version, model name
   and timestamp.
4. **Combination**: rules dominate the scam score (the model can raise it,
   not lower it below the rules' floor); relevance comes from matching and
   the model; the status shown is always explainable from the stored signals.

Limits: rules are pattern-based and can miss novel scams or flag legitimate
listings that mention, say, equipment stipends; models hallucinate — which is
why nothing acts on a score, every draft ships with an evidence panel, and the
final call is always yours.

## 7. Export and delete data

- **CSV export**: *Export CSV* on the Radar page or
  `GET /api/opportunity-radar/export.csv`.
- **Full backup**: Settings → *Export JSON* (`/api/opportunity-radar/data/export.json`);
  restore with *Import JSON*.
- **Delete**: per-record delete on opportunities and résumé profiles, or
  Settings → *Delete all data* which requires typing `DELETE EVERYTHING` and
  removes opportunities, evaluations, applications, drafts, follow-ups, audit
  events and résumé indexes. Résumé *files* in your folder are never touched.
  Deleting the SQLite file (`data/`) is equivalent.

## 8. Troubleshooting

| Symptom | What to check |
|---|---|
| Widget not visible on the dashboard | The service is not running or is on another port; the widget probes `data-radar-base` (`http://127.0.0.1:4747`). Set `localStorage.ftw_radar_base` if you changed the port, or `localStorage.ftw_radar_widget = "always"` to show the offline state. |
| `401 Not authorised` | A token is configured; paste it in Settings (kept in `sessionStorage`) or `localStorage.ftw_radar_token` for the widget. |
| `421 Host header is not allowed` | The request used a hostname that is not loopback or in `OPPORTUNITY_RADAR_ALLOWED_ORIGINS` (DNS-rebinding protection). |
| AI status "not reachable" | Start Ollama (`ollama serve`) and confirm `OLLAMA_BASE_URL`. Rules, matching, template drafts and tracking keep working. |
| AI status "model not pulled" | `ollama pull <model>` or change `OLLAMA_MODEL`. |
| "Model output did not match the expected schema" | The model produced invalid JSON twice. Try a larger model, lower load, or use *Template draft*. Nothing was stored from the invalid output. |
| Résumé shows `NEEDS_OCR` | See section 3. |
| Résumé shows `POOR` | Text extracted but looks incomplete (columns, tables, icons). Save a simpler single-column version. |
| URL ingestion says "prohibits automated access" | That platform forbids automation; open the employer's own career page or enter details manually. |
| URL ingestion says "login or CAPTCHA" | The page requires a session; a stub record was created — fill in the description manually. |
| `EADDRINUSE` | Another process is using the port; set `OPPORTUNITY_RADAR_PORT`. |
| Node prints an ExperimentalWarning about SQLite | Harmless; the scripts pass `--disable-warning=ExperimentalWarning`. |
