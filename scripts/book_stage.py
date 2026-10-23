#!/usr/bin/env python3
"""
book_stage.py -- FTW Labs book staging + review agent.

Every finished book sits in a LOCAL staging area for a hold window (default
7 days). Each day the agent re-reviews it -- completeness, text hygiene,
continuity against the Chroma database of earlier books, character-name
collisions, fact-check flags for timely nonfiction -- and only promotes it to
the public shelf at ftwlabs.ai/books/ when:

  1. the hold window has passed,
  2. the latest review has zero blocking issues, and
  3. you have approved it (`approve --book ...`).

Staging is local on purpose: the site repo is PUBLIC on GitHub, so anything
committed there is readable by anyone the moment it is pushed, whatever the
page says. Only a promoted book (cover, blurb, preview chapter) ever touches
the repo. Optionally a "teaser" (title + cover + expected date, no text) can
go up early as marketing.

Commands
  init     --book DIR            scaffold DIR/metadata.json from book_bible.json
  stage    --book DIR            put a book into staging (starts the clock)
  review   [--book SLUG]         review staged books, rebuild the dashboard
  approve  --book SLUG           your sign-off (still needs hold + clean review)
  hold     --book SLUG --note T  block promotion with a note
  release  --book SLUG           clear a hold
  tease    --book SLUG           publish a no-text teaser card to the site
  promote  [--push]             promote every eligible book to the site
  daily    [--push]             review all + promote eligible (schedule this)
  next                           print the recommended release queue
  calibrate                      sample Chroma similarities to tune thresholds
  index    --book SLUG           add a book's chapters to Chroma

Stdlib only, except: chromadb (continuity checks), Pillow (optional cover
resizing). Config: book_stage.config.json next to this script, or --config.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import random
import re
import shutil
import statistics
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
TODAY = dt.date.today

DEFAULTS = {
    "staging_dir": "X:/AI_Workspace/_book_staging",
    "site_repo": str(HERE.parent),
    "hold_days": 7,
    "restart_clock_on_edit": True,
    "chapter_globs": ["Chapter_*_Final.md", "Chapter_*.md", "chapter_*.md"],
    "min_chapter_words": 1500,
    "require_chapter_art": False,
    "preview_chapters": 1,
    "kdp_select_preview_max_ratio": 0.10,
    "chroma": {
        "enabled": True,
        "path": "X:/AI_Workspace/chroma_books",
        "collection": "books",
        "book_key": "book",
        "embedding": {"provider": "ollama", "model": "nomic-embed-text",
                      "url": "http://localhost:11434"},
        "chunk_chars": 1200,
        "max_queries_per_chapter": 12,
        "dup_similarity": 0.92,
        "similar_similarity": 0.85,
        "index_on_promote": False,
    },
    "marketing": {"ollama_url": "http://localhost:11434", "model": "dolphin-mistral"},
}

BLOCK_PATTERNS = [
    r"\bas an ai\b", r"\bas a (large )?language model\b", r"\bi cannot (fulfill|comply|help with)\b",
    r"\bi'?m sorry,? but\b", r"</?think>", r"\[insert", r"lorem ipsum", r"```",
    r"\bhere(?:'s| is) (?:the )?(?:revised |final )?chapter\b", r"\bword count:", r"^\s*certainly[!,.]",
    r"\{\{.*?\}\}", r"\[(?:character|name|placeholder)[^\]]*\]",
]
WARN_PATTERNS = [r"\btodo\b", r"\btbd\b", r"\bxx+\b"]
FACT_RE = re.compile(
    r"\b(1[89]\d\d|20\d\d)\b|\d+(?:\.\d+)?\s?%|\$\s?\d|\bpercent\b|\baccording to\b|"
    r"\b(study|studies|survey|report|researchers|scientists found)\b", re.I)


# --------------------------------------------------------------------- config

def deep_merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def load_config(path: str | None) -> dict:
    p = Path(path) if path else HERE / "book_stage.config.json"
    cfg = DEFAULTS
    if p.exists():
        cfg = deep_merge(DEFAULTS, json.loads(p.read_text(encoding="utf-8")))
    elif path:
        sys.exit(f"Config not found: {p}")
    cfg["_staging"] = Path(cfg["staging_dir"])
    cfg["_repo"] = Path(cfg["site_repo"])
    return cfg


def read_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")[:60]


# --------------------------------------------------------------------- book IO

class Book:
    def __init__(self, folder: Path, cfg: dict):
        self.folder = folder
        self.cfg = cfg
        self.meta = read_json(folder / "metadata.json", None)
        if self.meta is None:
            raise SystemExit(f"{folder} has no metadata.json -- run: init --book \"{folder}\"")
        self.slug = self.meta.get("slug") or slugify(self.meta.get("title", folder.name))
        self.bible = read_json(folder / "book_bible.json", {})

    def chapters(self) -> list[tuple[int, Path]]:
        for g in self.cfg["chapter_globs"]:
            found = []
            for p in sorted(self.folder.glob(g)):
                m = re.search(r"(\d+)", p.stem)
                if m:
                    found.append((int(m.group(1)), p))
            if found:
                return sorted(found)
        return []

    def chapter_text(self, p: Path) -> str:
        return p.read_text(encoding="utf-8", errors="replace")

    def cover(self) -> Path | None:
        c = self.meta.get("cover")
        if c and (self.folder / c).exists():
            return self.folder / c
        for ext in ("jpg", "jpeg", "png", "webp"):
            for p in self.folder.glob(f"*cover*.{ext}"):
                return p
        return None

    def images_for_chapter(self, n: int) -> list[Path]:
        rx = re.compile(rf"(?:ch|chapter)[ _\-]?0*{n}(?!\d)", re.I)
        return [p for p in self.folder.rglob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
                and rx.search(p.stem)]

    def fingerprint(self) -> str:
        h = hashlib.sha256()
        files = [p for _, p in self.chapters()] + [self.folder / "metadata.json"]
        c = self.cover()
        if c:
            files.append(c)
        for p in files:
            h.update(p.name.encode())
            h.update(p.read_bytes())
        return h.hexdigest()[:16]

    def characters(self) -> set[str]:
        chars = self.bible.get("characters") or self.meta.get("characters") or []
        names = set()
        for c in chars if isinstance(chars, list) else chars.keys() if isinstance(chars, dict) else []:
            name = c.get("name") if isinstance(c, dict) else c
            if isinstance(name, str) and name.strip():
                names.add(name.strip())
        return names


def md_to_paragraphs(text: str) -> tuple[str | None, list[str]]:
    title = None
    paras = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        b = block.strip()
        if not b or re.fullmatch(r"[-*_]{3,}", b):
            continue
        b = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", b)
        m = re.match(r"^#{1,6}\s+(.*)", b)
        if m:
            if title is None:
                title = m.group(1).strip()
            continue
        b = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", b)
        b = re.sub(r"(\*\*|__|\*|_)(.+?)\1", r"\2", b)
        b = re.sub(r"\s*\n\s*", " ", b).strip()
        if b:
            paras.append(b)
    return title, paras


def words(s: str) -> int:
    return len(re.findall(r"\b\w+\b", s))


# --------------------------------------------------------------------- ledger

def ledger_path(cfg) -> Path:
    return cfg["_staging"] / "ledger.json"


def load_ledger(cfg) -> dict:
    return read_json(ledger_path(cfg), {"books": {}})


def save_ledger(cfg, led) -> None:
    write_json(ledger_path(cfg), led)


def get_entry(led, slug) -> dict:
    if slug not in led["books"]:
        sys.exit(f"'{slug}' is not staged. Staged: {', '.join(led['books']) or '(none)'}")
    return led["books"][slug]


def days_staged(e) -> int:
    return (TODAY() - dt.date.fromisoformat(e["staged_at"])).days


# --------------------------------------------------------------------- chroma

class Continuity:
    def __init__(self, cfg):
        self.c = cfg["chroma"]
        self.col = None
        self.err = None
        if not self.c.get("enabled"):
            self.err = "disabled in config"
            return
        try:
            import chromadb  # noqa
        except ImportError:
            self.err = "chromadb not installed (pip install chromadb)"
            return
        try:
            client = chromadb.PersistentClient(path=self.c["path"])
            self.col = client.get_collection(self.c["collection"])
        except Exception as ex:  # noqa: BLE001
            self.err = f"cannot open collection '{self.c['collection']}' at {self.c['path']}: {ex}"

    # ---- embeddings must match whatever built the collection
    def embed(self, texts: list[str]) -> list[list[float]]:
        e = self.c["embedding"]
        if e["provider"] == "ollama":
            url = e["url"].rstrip("/")
            try:
                return _post(f"{url}/api/embed", {"model": e["model"], "input": texts})["embeddings"]
            except Exception:  # older Ollama
                return [_post(f"{url}/api/embeddings", {"model": e["model"], "prompt": t})["embedding"]
                        for t in texts]
        if e["provider"] == "default":
            from chromadb.utils import embedding_functions
            return [list(map(float, v)) for v in embedding_functions.DefaultEmbeddingFunction()(texts)]
        raise SystemExit(f"Unknown embedding provider {e['provider']}")

    def stored_dim(self) -> int | None:
        got = self.col.get(limit=1, include=["embeddings"])
        embs = got.get("embeddings")
        return len(embs[0]) if embs is not None and len(embs) else None

    def chunks(self, text: str) -> list[str]:
        _, paras = md_to_paragraphs(text)
        size, out, cur = self.c["chunk_chars"], [], ""
        for p in paras:
            if len(cur) + len(p) > size and cur:
                out.append(cur)
                cur = ""
            cur = f"{cur}\n\n{p}" if cur else p
        if cur:
            out.append(cur)
        return out

    def check(self, book: Book) -> tuple[list[dict], str | None]:
        if self.col is None:
            return [], self.err
        key = self.c["book_key"]
        own = book.meta.get("chroma_book_id") or book.folder.name
        dim = self.stored_dim()
        if dim is None:
            return [], "collection is empty"
        hits = []
        for n, p in book.chapters():
            ch = self.chunks(book.chapter_text(p))
            if not ch:
                continue
            step = max(1, len(ch) // self.c["max_queries_per_chapter"])
            sample = ch[::step][: self.c["max_queries_per_chapter"]]
            q = self.embed(sample)
            if len(q[0]) != dim:
                return [], (f"embedding size {len(q[0])} != collection's {dim}: config.chroma.embedding "
                            "must name the same model that built the collection")
            res = self.col.query(query_embeddings=q, n_results=3, where={key: {"$ne": own}},
                                 include=["embeddings", "documents", "metadatas"])
            for i, qv in enumerate(q):
                for doc, meta, ev in zip(res["documents"][i], res["metadatas"][i], res["embeddings"][i]):
                    sim = cosine(qv, ev)
                    if sim >= self.c["similar_similarity"]:
                        hits.append({
                            "chapter": n, "similarity": round(sim, 3),
                            "level": "block" if sim >= self.c["dup_similarity"] else "warn",
                            "other_book": (meta or {}).get(key, "?"),
                            "ours": sample[i][:240], "theirs": (doc or "")[:240],
                        })
        hits.sort(key=lambda h: -h["similarity"])
        # one line per (chapter, other book): strongest match + how many chunks matched
        best: dict = {}
        for h in hits:
            k = (h["chapter"], h["other_book"])
            if k not in best:
                best[k] = dict(h, count=0)
            best[k]["count"] += 1
        return list(best.values()) + self.verbatim(book, own), None

    def verbatim(self, book: Book, own: str) -> list[dict]:
        """Lexical check, independent of the embedding model: 8-word shingles of every
        paragraph vs. every other book's stored text. Catches lifted passages that a
        1,200-char embedding chunk would dilute."""
        key = self.c["book_key"]
        got = self.col.get(where={key: {"$ne": own}}, include=["documents", "metadatas"])
        index: dict[int, str] = {}
        for doc, meta in zip(got["documents"], got["metadatas"]):
            for sh in shingles(doc or ""):
                index.setdefault(sh, (meta or {}).get(key, "?"))
        out = []
        for n, p in book.chapters():
            _, paras = md_to_paragraphs(book.chapter_text(p))
            for para in paras:
                sh = shingles(para)
                if len(sh) < 12:
                    continue
                found = [index[s] for s in sh if s in index]
                ratio = len(found) / len(sh)
                if ratio >= 0.5:
                    other = max(set(found), key=found.count)
                    out.append({"chapter": n, "similarity": round(ratio, 3), "level": "block",
                                "other_book": other, "count": 1, "verbatim": True,
                                "ours": para[:240], "theirs": ""})
        return out

    def index(self, book: Book) -> int:
        if self.col is None:
            sys.exit(f"Chroma unavailable: {self.err}")
        key = self.c["book_key"]
        own = book.meta.get("chroma_book_id") or book.folder.name
        n_added = 0
        for n, p in book.chapters():
            ch = self.chunks(book.chapter_text(p))
            if not ch:
                continue
            self.col.upsert(ids=[f"{own}::ch{n:02d}::{i:03d}" for i in range(len(ch))],
                            embeddings=self.embed(ch), documents=ch,
                            metadatas=[{key: own, "chapter": n, "title": book.meta.get("title", "")}] * len(ch))
            n_added += len(ch)
        return n_added


def shingles(text: str, k: int = 8) -> set[int]:
    w = re.findall(r"[a-z0-9']+", text.lower())
    return {hash(" ".join(w[i:i + k])) for i in range(len(w) - k + 1)}


def cosine(a, b) -> float:
    a, b = list(map(float, a)), list(map(float, b))
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def _post(url: str, payload: dict, timeout: int = 300) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# --------------------------------------------------------------------- review

def review_book(book: Book, cfg: dict, led: dict, cont: Continuity | None) -> dict:
    issues: list[dict] = []

    def add(level, check, msg, **extra):
        issues.append({"level": level, "check": check, "msg": msg, **extra})

    m = book.meta
    # ---- completeness
    for f in ("title", "blurb", "genre"):
        if not str(m.get(f, "")).strip():
            add("block", "metadata", f"metadata.json is missing '{f}'")
    kw = m.get("keywords") or []
    if not kw:
        add("block", "metadata", "no KDP keywords")
    elif len(kw) != 7:
        add("warn", "metadata", f"{len(kw)} keywords -- KDP gives you 7 slots, use them all")
    if not m.get("categories"):
        add("block", "metadata", "no KDP categories")
    if len(str(m.get("blurb", ""))) > 4000:
        add("block", "metadata", "blurb over KDP's 4,000-character description limit")
    if book.cover() is None:
        add("block", "cover", "no cover image found (metadata.cover or *cover*.jpg/png)")

    chapters = book.chapters()
    if not chapters:
        add("block", "chapters", f"no chapter files matched {cfg['chapter_globs']}")
    nums = [n for n, _ in chapters]
    missing = sorted(set(range(1, max(nums) + 1)) - set(nums)) if nums else []
    if missing:
        add("block", "chapters", f"chapter numbers missing: {missing}")
    if m.get("expected_chapters") and len(nums) != int(m["expected_chapters"]):
        add("block", "chapters", f"{len(nums)} chapters found, metadata expects {m['expected_chapters']}")

    counts, seen_paras, total = {}, {}, 0
    facts = []
    timely = bool(m.get("timely") or m.get("nonfiction"))
    for n, p in chapters:
        text = book.chapter_text(p)
        _, paras = md_to_paragraphs(text)
        wc = words(text)
        counts[n] = wc
        total += wc
        low = text.lower()
        for pat in BLOCK_PATTERNS:
            for mm in re.finditer(pat, low, re.M):
                ctx = text[max(0, mm.start() - 60): mm.end() + 60].replace("\n", " ")
                add("block", "hygiene", f"ch {n}: generation artifact /{pat}/", context=ctx)
                break
        for pat in WARN_PATTERNS:
            if re.search(pat, low):
                add("warn", "hygiene", f"ch {n}: possible leftover marker /{pat}/")
        for para in paras:
            if len(para) >= 200:
                k = re.sub(r"[^a-z0-9 ]", "", para.lower())
                if k in seen_paras:
                    add("block", "repetition", f"ch {n}: paragraph repeated verbatim from ch {seen_paras[k]}",
                        context=para[:200])
                else:
                    seen_paras[k] = n
            if timely and FACT_RE.search(para):
                for s in re.split(r"(?<=[.!?])\s+", para):
                    if FACT_RE.search(s) and len(facts) < 80:
                        facts.append({"chapter": n, "claim": s[:300]})
        if cfg["require_chapter_art"] and not book.images_for_chapter(n):
            add("warn", "art", f"ch {n}: no chapter art found")

    if counts:
        med = statistics.median(counts.values())
        for n, wc in counts.items():
            if wc < cfg["min_chapter_words"]:
                add("warn", "length", f"ch {n}: {wc} words (min {cfg['min_chapter_words']})")
            elif wc < 0.4 * med:
                add("warn", "length", f"ch {n}: {wc} words, far under the book's median {int(med)}")

    # ---- preview vs KDP Select
    prev_words = sum(counts.get(n, 0) for n in nums[: cfg["preview_chapters"]])
    if m.get("kdp_select") and total and prev_words / total > cfg["kdp_select_preview_max_ratio"]:
        add("warn", "preview", f"preview is {prev_words / total:.0%} of the book; it will be trimmed to "
                               f"{cfg['kdp_select_preview_max_ratio']:.0%} for KDP Select")

    # ---- character collisions with other books
    mine = book.characters()
    if mine:
        for slug, e in led["books"].items():
            if slug == book.slug:
                continue
            try:
                other = Book(Path(e["folder"]), cfg)
            except SystemExit:
                continue
            if other.meta.get("series") and other.meta.get("series") == m.get("series"):
                continue
            shared = mine & other.characters()
            if shared:
                add("warn", "characters", f"character name(s) also used in '{other.meta.get('title')}': "
                                          f"{', '.join(sorted(shared))}")

    # ---- Chroma continuity
    continuity_note = None
    if cont is not None:
        hits, continuity_note = cont.check(book)
        for h in sorted(hits, key=lambda h: (h["level"] != "block", -h["similarity"]))[:30]:
            if h.get("verbatim"):
                msg = f"ch {h['chapter']}: {h['similarity']:.0%} of a paragraph matches {h['other_book']} word for word"
            else:
                msg = (f"ch {h['chapter']}: plot/passage {h['similarity']:.2f} similar to {h['other_book']}"
                       f" ({h['count']} chunk{'s' if h['count'] > 1 else ''})")
            add(h["level"], "continuity", msg, ours=h["ours"], theirs=h["theirs"])
        if continuity_note:
            add("warn", "continuity", f"continuity check skipped: {continuity_note}")

    if timely and facts:
        add("warn", "facts", f"{len(facts)} factual claims (dates, figures, studies) need a human check -- "
                             "see the review file")

    blocks = [i for i in issues if i["level"] == "block"]
    return {
        "slug": book.slug, "title": m.get("title"), "at": dt.datetime.now().isoformat(timespec="seconds"),
        "fingerprint": book.fingerprint(), "verdict": "PASS" if not blocks else "BLOCKED",
        "blocking": len(blocks), "warnings": len(issues) - len(blocks),
        "chapters": len(nums), "words": total, "issues": issues, "fact_checks": facts,
    }


def write_review_md(cfg, rev) -> Path:
    out = cfg["_staging"] / rev["slug"] / "review.md"
    lines = [f"# Review: {rev['title']}", "",
             f"- Run: {rev['at']}", f"- Verdict: **{rev['verdict']}** ({rev['blocking']} blocking, "
             f"{rev['warnings']} warnings)", f"- {rev['chapters']} chapters, {rev['words']:,} words", ""]
    for level, head in (("block", "## Blocking -- must fix before promotion"), ("warn", "## Warnings")):
        items = [i for i in rev["issues"] if i["level"] == level]
        lines += [head, ""] + (["- none"] if not items else [])
        for i in items:
            lines.append(f"- [{i['check']}] {i['msg']}")
            for k in ("context", "ours", "theirs"):
                if i.get(k):
                    lines.append(f"  - {k}: \"{i[k]}\"")
        lines.append("")
    if rev["fact_checks"]:
        lines += ["## Fact-check list", ""] + [f"- [ ] ch {f['chapter']}: {f['claim']}" for f in rev["fact_checks"]]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    write_json(out.with_suffix(".json"), rev)
    return out


# --------------------------------------------------------------------- queue + dashboard

def eligibility(e, cfg) -> tuple[bool, str]:
    r = e.get("last_review")
    left = cfg["hold_days"] - days_staged(e)
    if e.get("status") == "live":
        return False, "live"
    if e.get("hold_note"):
        return False, f"held: {e['hold_note']}"
    if not r:
        return False, "not reviewed yet"
    if r["verdict"] != "PASS":
        return False, f"{r['blocking']} blocking issue(s)"
    if left > 0:
        return False, f"{left} day(s) left in hold"
    if not e.get("approved"):
        return False, "waiting for your approval"
    return True, "ready to promote"


def queue(led, cfg) -> list[tuple[str, dict, bool, str]]:
    rows = []
    for slug, e in led["books"].items():
        if e.get("status") == "live":
            continue
        ok, why = eligibility(e, cfg)
        rows.append((slug, e, ok, why))

    def key(r):
        slug, e, ok, _ = r
        rv = e.get("last_review") or {}
        return (not ok, rv.get("verdict") != "PASS", not e.get("timely"),
                e.get("series") or "~", e.get("series_index") or 0, e["staged_at"])
    return sorted(rows, key=key)


def write_dashboard(cfg, led) -> Path:
    rows = queue(led, cfg)
    live = [(s, e) for s, e in led["books"].items() if e.get("status") == "live"]
    tr = []
    for i, (slug, e, ok, why) in enumerate(rows, 1):
        r = e.get("last_review") or {}
        tr.append(f"<tr class='{'ok' if ok else ('bad' if r.get('verdict') == 'BLOCKED' else '')}'>"
                  f"<td>{i}</td><td><b>{html.escape(e['title'])}</b><br><span class='m'>{slug}</span></td>"
                  f"<td>{days_staged(e)}/{cfg['hold_days']}</td><td>{r.get('verdict', '-')}</td>"
                  f"<td>{r.get('blocking', '-')} / {r.get('warnings', '-')}</td>"
                  f"<td>{'yes' if e.get('approved') else 'no'}</td><td>{html.escape(why)}</td>"
                  f"<td><a href='{slug}/review.md'>review</a></td></tr>")
    lv = "".join(f"<li>{html.escape(e['title'])} <span class='m'>live {e.get('live_at', '')}</span></li>"
                 for _, e in live) or "<li class='m'>none yet</li>"
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Book Staging</title>
<style>:root{{--paper:#E8E1CE;--raised:#DFD7C0;--ink:#1C1A22;--soft:#55505A;--hot:#D5294F;--ok:#2E7D4F;--line:#B3A98D}}
@media(prefers-color-scheme:dark){{:root{{--paper:#18151C;--raised:#221E28;--ink:#ECE6D6;--soft:#B6AEA0;--hot:#FF5D82;--ok:#5FD08F;--line:#3C3742}}}}
body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:24px 16px}}
h1{{text-transform:uppercase;letter-spacing:.02em}}.m{{font:12px ui-monospace,monospace;color:var(--soft)}}
.wrap{{overflow-x:auto}}table{{border-collapse:collapse;width:100%;background:var(--raised)}}td,th{{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}}
tr.ok td:first-child{{box-shadow:inset 4px 0 var(--ok)}}tr.bad td:first-child{{box-shadow:inset 4px 0 var(--hot)}}a{{color:var(--ink)}}</style></head>
<body><main><h1>Book staging</h1><p class="m">Updated {dt.datetime.now():%Y-%m-%d %H:%M}. Order = recommended release queue.
Promotion needs: {cfg['hold_days']}-day hold + clean review + your approval.</p>
<div class="wrap"><table><tr><th>#</th><th>Book</th><th>Days</th><th>Review</th><th>Block / warn</th><th>Approved</th><th>Status</th><th></th></tr>
{''.join(tr) or '<tr><td colspan=8 class=m>Nothing staged.</td></tr>'}</table></div>
<h2>Live</h2><ul>{lv}</ul></main></body></html>"""
    out = cfg["_staging"] / "dashboard.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    return out


# --------------------------------------------------------------------- site output

def site_books_path(cfg) -> Path:
    return cfg["_repo"] / "books" / "books.json"


def copy_cover(src: Path, dest_dir: Path) -> str:
    dest_dir.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        im = Image.open(src).convert("RGB")
        im.thumbnail((1200, 1800))
        im.save(dest_dir / "cover.jpg", "JPEG", quality=85, optimize=True)
        return "cover.jpg"
    except Exception:  # Pillow missing or odd file: copy as-is
        name = "cover" + src.suffix.lower()
        shutil.copyfile(src, dest_dir / name)
        return name


def public_entry(book: Book, e: dict, status: str, cover_name: str) -> dict:
    m = book.meta
    return {
        "slug": book.slug, "status": status, "title": m["title"], "subtitle": m.get("subtitle", ""),
        "series": m.get("series", ""), "series_index": m.get("series_index"),
        "genre": m.get("genre", ""), "blurb": m.get("blurb", "") if status == "live" else m.get("teaser", ""),
        "cover": f"{book.slug}/{cover_name}", "amazon_url": m.get("amazon_url") or None,
        "launch_date": m.get("launch_date") or (dt.date.fromisoformat(e["staged_at"])
                                                + dt.timedelta(days=book.cfg["hold_days"])).isoformat(),
        "live_at": TODAY().isoformat() if status == "live" else None,
        "chapters": e.get("last_review", {}).get("chapters"),
        "preview": f"{book.slug}/preview.json" if status == "live" else None,
    }


def upsert_public(cfg, entry: dict) -> None:
    p = site_books_path(cfg)
    books = [b for b in read_json(p, []) if b["slug"] != entry["slug"]]
    books.append(entry)
    write_json(p, books)


def build_preview(book: Book, cfg: dict) -> dict:
    chs = book.chapters()
    total = sum(words(book.chapter_text(p)) for _, p in chs)
    cap = int(total * cfg["kdp_select_preview_max_ratio"]) if book.meta.get("kdp_select") else None
    used, out = 0, []
    for n, p in chs[: cfg["preview_chapters"]]:
        title, paras = md_to_paragraphs(book.chapter_text(p))
        kept = []
        for para in paras:
            w = words(para)
            if cap is not None and used + w > cap:
                break
            kept.append(para)
            used += w
        out.append({"n": n, "title": title or f"Chapter {n}", "paragraphs": kept})
        if cap is not None and used >= cap:
            break
    return {"title": book.meta["title"], "chapters": out, "words": used}


def git_push(cfg, message: str) -> None:
    repo = cfg["_repo"]
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True)  # noqa: E731
    run("add", "books")
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=repo).returncode == 0:
        print("  nothing to commit")
        return
    run("commit", "-m", message)
    run("pull", "--rebase", "--autostash")
    run("push")


# --------------------------------------------------------------------- marketing kit

def marketing_kit(book: Book, cfg: dict) -> Path:
    m = book.meta
    out = cfg["_staging"] / book.slug / "marketing_kit.md"
    prompt = (f"You are the marketing lead for an indie press. Book: '{m['title']}' ({m.get('genre')}).\n"
              f"Blurb: {m.get('blurb')}\n\nWrite, in markdown: 3 hook lines under 12 words; 3 social posts "
              "(one per: X, Instagram, Facebook) under 60 words each; one 30-second vertical reel script "
              "with shot list; 5 hashtags. No invented reviews, quotes, awards or sales claims.")
    body = None
    try:
        mk = cfg["marketing"]
        body = _post(f"{mk['ollama_url'].rstrip('/')}/api/generate",
                     {"model": mk["model"], "prompt": prompt, "stream": False}, timeout=600)["response"]
    except Exception as ex:  # noqa: BLE001
        body = (f"_Local model unavailable ({ex}); template below._\n\n## Hook\n{m['title']} -- "
                f"{m.get('subtitle') or m.get('genre')}\n\n## Post\n{m.get('blurb', '')[:280]}\n\n"
                f"Read the first chapter free: https://ftwlabs.ai/books/book.html?b={book.slug}\n")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"# Marketing kit: {m['title']}\n\nLanding page: https://ftwlabs.ai/books/book.html?b="
                   f"{book.slug}\n\n{body}\n", encoding="utf-8")
    return out


# --------------------------------------------------------------------- commands

def cmd_init(a, cfg):
    folder = Path(a.book)
    p = folder / "metadata.json"
    if p.exists():
        sys.exit(f"{p} already exists")
    bible = read_json(folder / "book_bible.json", {})
    title = bible.get("title") or re.sub(r"^Book\d+[_\- ]*", "", folder.name).replace("_", " ").strip(" -")
    meta = {
        "title": title, "subtitle": bible.get("subtitle", ""), "slug": slugify(title),
        "series": bible.get("series", ""), "series_index": bible.get("series_index"),
        "genre": bible.get("genre", ""), "timely": False, "nonfiction": False, "kdp_select": True,
        "blurb": "", "teaser": "", "keywords": [], "categories": [], "cover": "",
        "expected_chapters": None, "chroma_book_id": folder.name, "amazon_url": "", "launch_date": "",
    }
    write_json(p, meta)
    print(f"Wrote {p} -- fill in blurb, keywords (7), categories, cover, then: stage --book \"{folder}\"")


def cmd_stage(a, cfg):
    book = Book(Path(a.book).resolve(), cfg)
    led = load_ledger(cfg)
    if book.slug in led["books"] and not a.force:
        sys.exit(f"'{book.slug}' is already staged (use --force to restart its clock)")
    led["books"][book.slug] = {
        "title": book.meta.get("title", book.slug), "folder": str(book.folder),
        "staged_at": TODAY().isoformat(), "fingerprint": book.fingerprint(), "approved": False,
        "status": "staged", "timely": bool(book.meta.get("timely")),
        "series": book.meta.get("series", ""), "series_index": book.meta.get("series_index"),
    }
    save_ledger(cfg, led)
    print(f"Staged '{book.slug}'. Earliest promotion: "
          f"{TODAY() + dt.timedelta(days=cfg['hold_days'])}. Running first review...")
    do_review(cfg, led, only=book.slug)


def do_review(cfg, led, only=None):
    cont = Continuity(cfg) if cfg["chroma"].get("enabled") else None
    for slug, e in led["books"].items():
        if (only and slug != only) or e.get("status") == "live":
            continue
        book = Book(Path(e["folder"]), cfg)
        fp = book.fingerprint()
        if fp != e["fingerprint"]:
            if cfg["restart_clock_on_edit"]:
                e["staged_at"] = TODAY().isoformat()
                e["approved"] = False
                print(f"  {slug}: files changed -- hold clock restarted, approval cleared")
            e["fingerprint"] = fp
            if e.get("teased") and book.cover():  # keep the public "arrives" date honest
                upsert_public(cfg, public_entry(book, e, "teaser", copy_cover(book.cover(),
                                                cfg["_repo"] / "books" / slug)))
        rev = review_book(book, cfg, led, cont)
        path = write_review_md(cfg, rev)
        e["last_review"] = {k: rev[k] for k in ("at", "verdict", "blocking", "warnings", "chapters", "words")}
        ok, why = eligibility(e, cfg)
        print(f"  {slug}: {rev['verdict']} ({rev['blocking']} block / {rev['warnings']} warn) -- {why}  [{path}]")
    save_ledger(cfg, led)
    print(f"Dashboard: {write_dashboard(cfg, led)}")


def cmd_review(a, cfg):
    do_review(cfg, load_ledger(cfg), only=a.book)


def cmd_approve(a, cfg):
    led = load_ledger(cfg)
    e = get_entry(led, a.book)
    e["approved"] = True
    save_ledger(cfg, led)
    write_dashboard(cfg, led)
    print(f"Approved '{a.book}': {eligibility(e, cfg)[1]}")


def cmd_hold(a, cfg):
    led = load_ledger(cfg)
    get_entry(led, a.book)["hold_note"] = a.note or "held"
    save_ledger(cfg, led)
    write_dashboard(cfg, led)
    print(f"Holding '{a.book}'")


def cmd_release(a, cfg):
    led = load_ledger(cfg)
    get_entry(led, a.book).pop("hold_note", None)
    save_ledger(cfg, led)
    write_dashboard(cfg, led)
    print(f"Released hold on '{a.book}'")


def cmd_tease(a, cfg):
    led = load_ledger(cfg)
    e = get_entry(led, a.book)
    book = Book(Path(e["folder"]), cfg)
    cover = book.cover()
    if not cover:
        sys.exit("A teaser needs a cover.")
    name = copy_cover(cover, cfg["_repo"] / "books" / book.slug)
    upsert_public(cfg, public_entry(book, e, "teaser", name))
    e["teased"] = True
    save_ledger(cfg, led)
    print(f"Teaser for '{book.slug}' written to {site_books_path(cfg)} (title, cover, date -- no text)")
    if a.push:
        git_push(cfg, f"books: teaser for {book.meta['title']}")


def do_promote(cfg, led, push: bool) -> list[str]:
    promoted = []
    cont = None
    for slug, e in led["books"].items():
        ok, why = eligibility(e, cfg)
        if not ok:
            continue
        book = Book(Path(e["folder"]), cfg)
        if book.fingerprint() != e["fingerprint"]:
            print(f"  {slug}: changed since its review -- skipped; run review")
            continue
        dest = cfg["_repo"] / "books" / slug
        name = copy_cover(book.cover(), dest)
        write_json(dest / "preview.json", build_preview(book, cfg))
        upsert_public(cfg, public_entry(book, e, "live", name))
        e["status"], e["live_at"] = "live", TODAY().isoformat()
        kit = marketing_kit(book, cfg)
        if cfg["chroma"].get("index_on_promote"):
            cont = cont or Continuity(cfg)
            print(f"  {slug}: indexed {cont.index(book)} chunks into Chroma")
        print(f"  {slug}: PROMOTED -> books/{slug}/  (marketing kit: {kit})")
        promoted.append(book.meta["title"])
    save_ledger(cfg, led)
    write_dashboard(cfg, led)
    if promoted and push:
        git_push(cfg, "books: promote " + ", ".join(promoted))
    return promoted


def cmd_promote(a, cfg):
    if not do_promote(cfg, load_ledger(cfg), a.push):
        print("Nothing eligible. Run `next` to see why.")


def cmd_daily(a, cfg):
    led = load_ledger(cfg)
    print(f"== review {TODAY()} ==")
    do_review(cfg, led)
    print("== promote ==")
    if not do_promote(cfg, led, a.push):
        print("  nothing eligible today")
    cmd_next(a, cfg)


def cmd_next(a, cfg):
    rows = queue(load_ledger(cfg), cfg)
    if not rows:
        print("Queue empty -- nothing staged.")
        return
    print("Recommended release queue:")
    for i, (slug, e, ok, why) in enumerate(rows, 1):
        print(f"  {i:>2}. {'READY ' if ok else '      '}{e['title']}  -- {why}")


def cmd_calibrate(a, cfg):
    cont = Continuity(cfg)
    if cont.col is None:
        sys.exit(f"Chroma unavailable: {cont.err}")
    key = cfg["chroma"]["book_key"]
    got = cont.col.get(include=["embeddings", "metadatas"], limit=4000)
    items = [(m.get(key), e) for m, e in zip(got["metadatas"], got["embeddings"]) if m]
    if len(items) < 20:
        sys.exit("Need at least 20 chunks in the collection to calibrate.")
    sims = []
    for _ in range(3000):
        (b1, e1), (b2, e2) = random.sample(items, 2)
        if b1 != b2:
            sims.append(cosine(e1, e2))
    if len(sims) < 50:
        sys.exit("Calibration needs chunks from at least two different books in the collection.")
    sims.sort()
    pct = lambda q: sims[min(len(sims) - 1, int(q * len(sims)))]  # noqa: E731
    print(f"Cross-book chunk similarity over {len(sims)} random pairs:")
    for q in (0.5, 0.9, 0.99, 0.999):
        print(f"  p{q * 100:g}: {pct(q):.3f}")
    print(f"Current thresholds: similar >= {cfg['chroma']['similar_similarity']}, "
          f"duplicate >= {cfg['chroma']['dup_similarity']}.\nSet similar_similarity near p99.9 and "
          "dup_similarity clearly above it, or every book will flag on ordinary prose.")


def cmd_index(a, cfg):
    led = load_ledger(cfg)
    book = Book(Path(get_entry(led, a.book)["folder"]), cfg)
    print(f"Indexed {Continuity(cfg).index(book)} chunks for '{book.slug}'")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn, args in [
        ("init", cmd_init, ["book"]), ("stage", cmd_stage, ["book", "force"]), ("review", cmd_review, ["book?"]),
        ("approve", cmd_approve, ["book"]), ("hold", cmd_hold, ["book", "note"]),
        ("release", cmd_release, ["book"]), ("tease", cmd_tease, ["book", "push"]),
        ("promote", cmd_promote, ["push"]), ("daily", cmd_daily, ["push"]), ("next", cmd_next, []),
        ("calibrate", cmd_calibrate, []), ("index", cmd_index, ["book"]),
    ]:
        sp = sub.add_parser(name)
        sp.set_defaults(fn=fn)
        for arg in args:
            if arg in ("push", "force"):
                sp.add_argument(f"--{arg}", action="store_true")
            elif arg == "note":
                sp.add_argument("--note", default="")
            else:
                sp.add_argument("--book", required=not arg.endswith("?"))
    a = ap.parse_args()
    a.fn(a, load_config(a.config))


if __name__ == "__main__":
    main()
