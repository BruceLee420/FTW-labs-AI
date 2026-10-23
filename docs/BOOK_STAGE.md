# Book staging: setup and daily use

The public shelf lives at `ftwlabs.ai/books/`. Books get there only through
`scripts/book_stage.py`, which holds each finished book in a **local** staging
area, reviews it every day, and promotes it once three things are true:

1. The **hold window** has passed (7 days by default).
2. The latest **review has zero blocking issues**.
3. **You approved it**: `approve --book <slug>`.

## Why staging is not on the site

This repo is **public on GitHub**. Anything committed here can be read by
anyone the moment it is pushed, even if no page links to it. So staged
manuscripts never touch the repo. They stay in `staging_dir` on your machine.
The repo only ever receives three things:

- On promotion: the cover, the blurb, and a preview capped at 10% of the book for KDP Select.
- On `tease`: a title, cover and expected date, with no text.
- The `books/books.json` entry.

## One-time setup (Windows, on the machine with Chroma)

```
pip install chromadb pillow
copy scripts\book_stage.config.example.json scripts\book_stage.config.json
```

Edit `book_stage.config.json`:

- `staging_dir`: where ledger, reviews, dashboard and marketing kits live.
- `site_repo`: your local clone of this repo.
- `chroma.path`, `chroma.collection`: the database your books were ingested into.
- `chroma.book_key`: the metadata field that names the book on each chunk (for example `book`).
- `chroma.embedding`: must be the same model that built the collection. If
  it isn't, the script stops and says so.

Then run `calibrate` once. It prints how similar unrelated chunks from
*different* books usually are. Set `similar_similarity` near the p99.9 value
and `dup_similarity` clearly above it. Otherwise every book will flag on
ordinary prose.

## Per book

```
python scripts\book_stage.py init  --book "X:\AI_Workspace\Book16_-_The_Universe_Forgot"
  (fill in metadata.json: blurb, 7 keywords, categories, cover, timely/nonfiction, chroma_book_id)
python scripts\book_stage.py stage --book "X:\AI_Workspace\Book16_-_The_Universe_Forgot"
python scripts\book_stage.py tease --book the-universe-forgot --push     (optional)
  ... read staging_dir\<slug>\review.md, fix anything blocking ...
python scripts\book_stage.py approve --book the-universe-forgot
```

`chroma_book_id` must equal the value stored under `book_key` for that book's
own chunks. That's how the agent knows not to compare a book against itself.

## Daily run (schedule it)

```
schtasks /create /tn "FTW Book Stage" /sc daily /st 09:41 ^
  /tr "python X:\AI_Workspace\FTW-labs-AI\scripts\book_stage.py daily --push"
```

`daily` does four things:

- Re-reviews every staged book.
- Promotes eligible books, then commits and pushes so Pages redeploys.
- Writes a marketing kit for each promoted book using your local Ollama model.
- Prints the recommended release queue.

Open `staging_dir\dashboard.html` to see the queue at a glance.

## What the review checks

| Check | Blocks promotion | Warns |
|---|---|---|
| Metadata | missing title, blurb, genre, keywords, categories; blurb over 4,000 chars | fewer than 7 keywords |
| Cover | no cover file | |
| Chapters | gaps in numbering, wrong count vs `expected_chapters` | short chapters, length outliers |
| Hygiene | AI artifacts ("as an AI", `<think>`, "here is chapter", placeholders, code fences) | TODO/TBD markers |
| Repetition | a 200+ character paragraph repeated verbatim inside the book | |
| Continuity: verbatim | half or more of a paragraph matching another book word for word (8-word shingles against Chroma's stored text) | |
| Continuity: semantic | a chunk above `dup_similarity` to another book | chunks above `similar_similarity` (plot reuse) |
| Characters | | a character name reused in a book from a different series |
| Facts (timely/nonfiction) | | every dated or numeric claim, listed as a checkbox for a human |
| Preview | | preview over 10% (it gets trimmed automatically) |

**Editing any chapter, the cover, or `metadata.json` restarts the hold clock
and clears your approval.** The final review always covers the final text.
To turn that off, set `restart_clock_on_edit` to `false`.

## Other commands

- `next`: print the release queue. Ready books come first, then timely books, then by series order and staging date.
- `hold --book X --note "..."` and `release --book X`: block or unblock a book manually.
- `index --book X`: add a book to Chroma so later books are checked against it. To do this automatically on promotion, set `index_on_promote: true`.
