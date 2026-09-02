/**
 * Opportunity Radar — main page. Summary metrics, filters persisted in the URL,
 * a sortable paginated table, the Sources and "add manually" drawers, and the
 * detail drawer that walks the human-approved workflow: evaluate → draft →
 * approve → record as applied → follow up. Everything goes through
 * window.Radar.api; nothing here submits anything to a third party.
 */
(function () {
  "use strict";
  var R = window.Radar, el = R.el;
  var $ = function (id) { return document.getElementById(id); };
  var LIMIT = 50, TEXT_SORT = { companyName: 1, title: 1 };
  var state = { sort: "discoveredAt", order: "desc", offset: 0, total: 0 };
  var cache = { resumes: null, followUpDays: 7 };
  var current = null;
  var FILTER_IDS = {
    search: "f-search", status: "f-status", sourceType: "f-sourceType", workMode: "f-workMode", geographicEligibility: "f-geo",
    verificationStatus: "f-verification", minLegitimacy: "f-minLegitimacy", minRelevance: "f-minRelevance", maxScamRisk: "f-maxScamRisk",
    discoveredAfter: "f-discoveredAfter", discoveredBefore: "f-discoveredBefore",
  };
  function oppPath(id, suffix) { return "/opportunities/" + encodeURIComponent(id) + (suffix || ""); }
  function h4(text) { return el("h4", { class: "small", style: "margin-top:12px" }, text); }
  function statusLine() { return el("p", { class: "small hot", role: "status", "aria-live": "polite", style: "margin:6px 0 0" }); }
  function faint(text) { return el("p", { class: "faint small", style: "margin:0" }, text); }

  /* ---------- filters, URL state, sorting ---------- */
  function fillSelect(id, map, emptyLabel) {
    var s = $(id);
    R.enumOptions(map, emptyLabel).forEach(function (o) { s.appendChild(el("option", { value: o[0] }, o[1])); });
  }
  function readFilters() {
    var q = {};
    Object.keys(FILTER_IDS).forEach(function (k) { var n = $(FILTER_IDS[k]); q[k] = n.multiple ? R.selectedValues(n) : n.value.trim(); });
    return q;
  }
  function applyParams(p) {
    Object.keys(FILTER_IDS).forEach(function (k) {
      var n = $(FILTER_IDS[k]);
      if (n.multiple) { var vals = p.getAll(k); Array.prototype.forEach.call(n.options, function (o) { o.selected = vals.indexOf(o.value) !== -1; }); }
      else n.value = p.get(k) || "";
    });
    if (p.get("sort")) state.sort = p.get("sort");
    if (p.get("order") === "asc" || p.get("order") === "desc") state.order = p.get("order");
    state.offset = Math.max(0, parseInt(p.get("offset") || "0", 10) || 0);
  }
  function listQuery() { return Object.assign(readFilters(), { sort: state.sort, order: state.order, limit: LIMIT, offset: state.offset }); }
  function syncUrl() {
    var q = listQuery();
    delete q.limit;
    if (!q.offset) delete q.offset;
    history.replaceState(null, "", location.pathname + R.buildQuery(q) + location.hash);
    $("link-export").href = R.API_BASE + "/export.csv" + R.buildQuery(Object.assign(readFilters(), { sort: state.sort, order: state.order }));
    Array.prototype.forEach.call(document.querySelectorAll("th[data-sort]"), function (th) {
      th.setAttribute("aria-sort", th.getAttribute("data-sort") === state.sort ? (state.order === "asc" ? "ascending" : "descending") : "none");
    });
  }

  /* ---------- summary + list ---------- */
  function setStatus(msg) { $("list-status").textContent = msg; }
  function loadSummary() {
    return R.api("/summary").then(function (s) {
      var c = s.counts || {}, ai = s.ai || {}, box = R.clear($("metrics"));
      [["Total", c.total], ["Verified", c.verified], ["Needs review", c.needsReview], ["Ready to apply", c.readyToApply], ["Follow-ups due", c.followUpsDue, (c.followUpsDue || 0) > 0]]
        .forEach(function (m) {
          box.appendChild(el("div", { class: "card metric" + (m[2] ? " hot" : "") }, [el("span", { class: "num" }, String(m[1] || 0)), el("span", { class: "label" }, m[0])]));
        });
      box.appendChild(el("div", { class: "card metric" }, [
        el("span", { class: "label" }, "AI advisory"),
        el("span", null, el("span", { class: "badge " + (ai.reachable ? "ok" : "warn") }, ai.reachable ? "AI: " + (ai.model || "reachable") : "AI offline — rules only")),
        el("span", { class: "small faint" }, ai.message || ""),
      ]));
    }).catch(function (e) { R.clear($("metrics")).appendChild(el("div", { class: "notice hot" }, R.errorText(e))); });
  }
  function renderRows(items) {
    var tb = R.clear($("rows"));
    if (!items.length) { tb.appendChild(el("tr", null, el("td", { colspan: 12, class: "empty" }, "No opportunities match. Add a URL, add one manually, sync a source, or clear the filters."))); return; }
    items.forEach(function (o) {
      var due = o.followUpDueAt && R.isDue(o.followUpDueAt);
      var open = function () { openDetail(o.id); };
      tb.appendChild(el("tr", { tabindex: 0, "data-id": o.id, onclick: open, onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } }, [
        el("td", null, [o.companyName, o.companyDomain ? el("div", { class: "small faint mono" }, o.companyDomain) : null]),
        el("td", null, el("span", { class: "title" }, o.title)),
        el("td", null, R.label("workMode", o.workMode)),
        el("td", null, [R.label("geographicEligibility", o.geographicEligibility), (o.eligibleCountries || []).length ? el("div", { class: "small faint" }, o.eligibleCountries.join(", ")) : null]),
        el("td", null, [o.sourceName, " ", R.badgeFor(o.sourceType, "sourceType")]),
        el("td", null, R.badgeFor(o.verificationStatus, "verificationStatus")),
        el("td", null, R.scoreBar("Legitimacy", o.legitimacyScore)),
        el("td", null, R.scoreBar("Scam risk", o.scamRiskScore, true)),
        el("td", null, R.scoreBar("Relevance", o.relevanceScore)),
        el("td", null, R.badgeFor(o.status, "status")),
        el("td", null, R.fmtDate(o.discoveredAt)),
        el("td", { class: due ? "hot" : null }, o.followUpDueAt ? R.fmtDate(o.followUpDueAt) + (due ? " · due" : "") : "—"),
      ]));
    });
  }
  function renderPager() {
    var from = state.total ? state.offset + 1 : 0, to = Math.min(state.offset + LIMIT, state.total);
    $("pager-text").textContent = from + "–" + to + " of " + state.total;
    $("btn-prev").disabled = state.offset <= 0;
    $("btn-next").disabled = to >= state.total;
  }
  function loadList() {
    var wrap = $("table-wrap");
    wrap.setAttribute("aria-busy", "true");
    setStatus("Loading…");
    syncUrl();
    return R.api("/opportunities", { query: listQuery() }).then(function (res) {
      state.total = res.total || 0;
      renderRows(res.items || []);
      setStatus(state.total ? state.total + " opportunit" + (state.total === 1 ? "y" : "ies") + " · sorted by " + R.humanize(state.sort) + " " + state.order : "No opportunities match.");
    }).catch(function (e) { state.total = 0; renderRows([]); setStatus(R.errorText(e)); R.toast(R.errorText(e), "bad"); })
      .then(function () { renderPager(); wrap.removeAttribute("aria-busy"); });
  }
  function refreshAll() { return Promise.all([loadSummary(), loadList()]); }
  function loadResumes() {
    if (cache.resumes) return Promise.resolve(cache.resumes);
    return R.api("/resumes").then(function (r) { cache.resumes = r.items || []; return cache.resumes; }).catch(function () { cache.resumes = []; return cache.resumes; });
  }
  function resumeOptions(emptyLabel) {
    return [["", emptyLabel]].concat((cache.resumes || []).map(function (r) { return [r.id, r.label + (r.isActive ? "" : " (inactive)") + " — " + r.filename]; }));
  }

  /* ---------- add URL / add manually / sources ---------- */
  function onAddUrl(e) {
    e.preventDefault();
    var status = $("add-url-status"), url = $("add-url").value.trim(), notes = $("add-url-notes").value.trim();
    var body = { url: url };
    if (notes) body.notes = notes;
    status.textContent = "Fetching the listing once… this can take up to 15 seconds.";
    R.busy($("add-url-submit"), R.api("/opportunities/ingest-url", { body: body })).then(function (res) {
      var o = res.opportunity || {};
      status.textContent = (res.duplicate ? "Already tracked: " : "Added: ") + (o.title || "listing") +
        (res.accessBlocked ? " — the site blocked access; fill in the details manually." : res.extracted ? " (extracted via " + res.extracted.method + ")" : "");
      $("add-url").value = ""; $("add-url-notes").value = "";
      refreshAll();
      openDetail(res.duplicate && res.duplicateOf ? res.duplicateOf : o.id);
    }).catch(function (err) { status.textContent = R.errorText(err); R.toast(R.errorText(err), "bad"); });
  }
  function openManualForm() {
    var f = {};
    function fld(key, text, node, hint) { f[key] = node; return R.field(text, node, hint); }
    function v(k) { return (f[k].value || "").trim(); }
    var submit = el("button", { class: "btn", type: "submit" }, "Add opportunity");
    var form = el("form", { class: "stack", onsubmit: function (e) {
      e.preventDefault();
      var body = { companyName: v("companyName"), title: v("title"), rawDescription: v("rawDescription"), sourceName: v("sourceName") || "manual", sourceType: v("sourceType"),
        employmentType: v("employmentType"), workMode: v("workMode"), geographicEligibility: v("geographicEligibility") };
      ["sourceUrl", "applicationUrl", "companyWebsite", "officialCareerUrl", "locationText", "timezoneRequirements", "postedAt", "closesAt", "notes"].forEach(function (k) { if (v(k)) body[k] = v(k); });
      var countries = R.parseList(v("eligibleCountries"));
      if (countries.length) body.eligibleCountries = countries;
      if (v("compensation")) body.compensation = { text: v("compensation") };
      R.busy(submit, R.api("/opportunities/manual", { body: body })).then(function (res) {
        R.toast(res.duplicate ? "Already tracked — opening the existing record." : "Added: " + res.opportunity.title);
        refreshAll();
        openDetail(res.duplicate && res.duplicateOf ? res.duplicateOf : res.opportunity.id);
      }).catch(function (err) { R.toast(R.errorText(err), "bad"); });
    } }, [
      fld("companyName", "Company", R.input({ required: true, maxlength: 300 })),
      fld("title", "Title", R.input({ required: true, maxlength: 300 })),
      fld("rawDescription", "Description", R.textarea({ rows: 8 }), "Paste the listing text. Stored locally; analysed by the rules and, when reachable, your local model."),
      el("div", { class: "grid cols-2" }, [fld("sourceName", "Source name", R.input({ value: "manual", maxlength: 300 })), fld("sourceType", "Source type", R.select(R.enumOptions("sourceType"), "MANUAL_URL"))]),
      fld("sourceUrl", "Source URL", R.input({ type: "url", placeholder: "https://" })),
      fld("applicationUrl", "Application URL", R.input({ type: "url", placeholder: "https://" })),
      fld("companyWebsite", "Company website", R.input({ type: "url", placeholder: "https://" })),
      fld("officialCareerUrl", "Official careers URL", R.input({ type: "url", placeholder: "https://" })),
      el("div", { class: "grid cols-2" }, [fld("employmentType", "Employment type", R.select(R.enumOptions("employmentType"), "UNKNOWN")), fld("workMode", "Work mode", R.select(R.enumOptions("workMode"), "UNKNOWN"))]),
      fld("locationText", "Location", R.input({ maxlength: 300 })),
      el("div", { class: "grid cols-2" }, [fld("geographicEligibility", "Geographic eligibility", R.select(R.enumOptions("geographicEligibility"), "UNKNOWN")), fld("eligibleCountries", "Eligible countries (comma-separated)", R.input())]),
      fld("timezoneRequirements", "Timezone requirements", R.input({ maxlength: 300 })),
      fld("compensation", "Compensation (as written)", R.input({ maxlength: 300 })),
      el("div", { class: "grid cols-2" }, [fld("postedAt", "Posted", R.input({ type: "date" })), fld("closesAt", "Closes", R.input({ type: "date" }))]),
      fld("notes", "Notes", R.textarea({ rows: 3 })),
      el("div", { class: "row" }, [submit, el("span", { class: "small faint" }, "Runs the deterministic checks on save.")]),
    ]);
    R.drawer({ title: "Add an opportunity manually", content: form, focus: f.companyName });
  }
  function openSources() {
    var body = el("div", { class: "stack" }, faint("Loading…"));
    R.drawer({ title: "Sources", content: body });
    function load() {
      return R.api("/sources").then(function (res) {
        R.clear(body);
        body.appendChild(el("p", { class: "small muted", style: "margin:0" }, "Only permitted sources: official ATS APIs, feeds that allow syndication, fixtures. Synced items flow through the same normalise → dedupe → evaluate path as a manual entry."));
        (res.adapters || []).forEach(function (a) { body.appendChild(adapterCard(a, load)); });
        if (!(res.adapters || []).length) body.appendChild(faint("No adapters are registered."));
        body.appendChild(R.section("Recent runs", runsTable(res.recentRuns || [])));
      }).catch(function (e) { R.clear(body).appendChild(el("div", { class: "notice hot" }, R.errorText(e))); });
    }
    load();
  }
  function adapterCard(a, reload) {
    var datalist = el("datalist", { id: R.uid("targets") }, (a.suggestedTargets || []).map(function (t) { return el("option", { value: t }); }));
    var target = R.input({ list: datalist.id, placeholder: a.targetHint || "target", required: true, maxlength: 2048 });
    var evaluate = R.checkbox("Evaluate after sync", { checked: true });
    var status = statusLine(), btn = el("button", { class: "btn btn-sm", type: "submit" }, "Sync");
    var form = el("form", { class: "stack", onsubmit: function (e) {
      e.preventDefault();
      status.textContent = "Syncing…";
      R.busy(btn, R.api("/sources/sync", { body: { adapterId: a.id, target: target.value.trim(), evaluate: evaluate.input.checked } })).then(function (res) {
        var w = res.warnings || [];
        status.textContent = "Fetched " + res.run.fetched + " · created " + res.created + " · duplicates " + res.duplicates + (w.length ? " · " + w.length + " warning(s): " + w.slice(0, 3).join("; ") : "");
        R.toast("Sync finished: " + res.created + " new.");
        refreshAll(); reload();
      }).catch(function (err) { status.textContent = R.errorText(err); R.toast(R.errorText(err), "bad"); });
    } }, [
      el("h3", null, a.displayName), el("p", { class: "small muted", style: "margin:0" }, a.policyNote),
      (a.suggestedTargets || []).length ? el("div", { class: "row" }, [el("span", { class: "small faint" }, "Suggested:")].concat(a.suggestedTargets.map(function (t) {
        return el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: function () { target.value = t; target.focus(); } }, t);
      }))) : null,
      R.field("Target — " + (a.targetHint || "adapter target"), target), datalist, evaluate.label,
      el("div", { class: "row" }, [btn]), status,
    ]);
    return el("div", { class: "card", style: "margin-top:12px" }, form);
  }
  function runsTable(runs) {
    if (!runs.length) return faint("No sync runs yet.");
    return el("div", { class: "table-wrap" }, el("table", null, [
      el("thead", null, el("tr", null, ["Adapter", "Started", "Status", "Fetched", "New", "Dup.", "Errors"].map(function (t) { return el("th", { scope: "col" }, t); }))),
      el("tbody", null, runs.map(function (r) {
        return el("tr", null, [el("td", null, r.sourceName || r.adapterId), el("td", null, R.fmtDateTime(r.startedAt)), el("td", null, R.badgeFor(r.status, "syncStatus")),
          el("td", null, String(r.fetched)), el("td", null, String(r.created)), el("td", null, String(r.duplicates)), el("td", null, (r.errors || []).join("; ") || "—")]);
      })),
    ]));
  }

  /* ---------- detail drawer ---------- */
  function run(btn, promise, okMsg, statusEl) {
    if (statusEl) statusEl.textContent = "Working…";
    return R.busy(btn, promise).then(function (res) {
      if (okMsg) R.toast(okMsg);
      if (statusEl) statusEl.textContent = "";
      return res;
    }, function (e) {
      var msg = R.errorText(e);
      if (statusEl) statusEl.textContent = msg;
      R.toast(msg, "bad");
      return undefined;
    });
  }
  function openDetail(id) {
    if (!id) return Promise.resolve();
    var ctx = { id: id, approval: null, draftVersion: null, followUpDraft: null, open: true };
    ctx.drawer = R.drawer({ title: "Loading…", content: faint("Loading…"), onClose: function () {
      ctx.open = false;
      if (current === ctx) current = null;
      if (/^#opportunity=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    } });
    current = ctx;
    history.replaceState(null, "", location.pathname + location.search + "#opportunity=" + encodeURIComponent(id));
    ctx.reload = function () {
      return R.api(oppPath(id)).then(function (d) {
        if (!ctx.open) return;
        ctx.d = d;
        ctx.drawer.setTitle(d.opportunity.title);
        var body = R.clear(ctx.drawer.body);
        [secHeader, secScores, secDetails, secResume, secWorkspace, secApproval, secApplied, secFollowUp, secStatus, secNotes].forEach(function (fn) { body.appendChild(fn(ctx)); });
        if (!ctx.drawer.panel.contains(document.activeElement)) ctx.drawer.panel.focus();
      }).catch(function (e) { R.clear(ctx.drawer.body).appendChild(el("div", { class: "notice hot" }, R.errorText(e))); });
    };
    return loadResumes().then(ctx.reload);
  }
  function applicationUrlFor(o) { return o.applicationUrl || o.officialCareerUrl || o.canonicalUrl || o.sourceUrl || null; }
  function isApproved(ctx) { var a = ctx.d.application; return !!a && (a.status === "APPROVED" || a.status === "SUBMITTED"); }
  function packageDrafts(d) { return d.drafts.filter(function (x) { return x.kind === "APPLICATION_PACKAGE"; }).sort(function (a, b) { return b.version - a.version; }); }
  function followUpDrafts(d) { return d.drafts.filter(function (x) { return x.kind === "FOLLOW_UP_EMAIL"; }).sort(function (a, b) { return b.version - a.version; }); }
  function openOfficial(url) {
    return url ? el("a", { class: "btn", href: url, target: "_blank", rel: "noopener noreferrer" }, "Open official application page ↗")
      : el("div", { class: "notice hot" }, "No application URL is recorded. Find the listing on the employer's official careers site.");
  }

  function secHeader(ctx) {
    var o = ctx.d.opportunity, app = ctx.d.application;
    return el("div", { class: "stack" }, [
      el("p", { class: "muted", style: "margin:0" }, [o.companyName, o.companyDomain ? el("span", { class: "mono small" }, " · " + o.companyDomain) : null]),
      el("div", { class: "row" }, [R.badgeFor(o.verificationStatus, "verificationStatus"), R.badgeFor(o.status, "status"), R.badgeFor(o.workMode, "workMode"),
        R.badgeFor(o.geographicEligibility, "geographicEligibility"), app ? R.badgeFor(app.status, "applicationStatus") : null]),
      R.kv([["Source URL", R.linkOut(o.sourceUrl)], ["Application URL", R.linkOut(o.applicationUrl)], ["Official careers", R.linkOut(o.officialCareerUrl)], ["Company site", R.linkOut(o.companyWebsite)]]),
      faint("Links are shown verbatim so you can inspect the domain before opening them."),
      isApproved(ctx) ? openOfficial(applicationUrlFor(o)) : faint("The official application link unlocks after you approve a draft package below."),
      o.nextAction ? el("div", { class: "notice teal" }, ["Suggested next action: ", o.nextAction]) : null,
    ]);
  }
  function secScores(ctx) {
    var o = ctx.d.opportunity, ev = ctx.d.latestEvaluation, status = statusLine();
    var reBtn = el("button", { class: "btn btn-sm", type: "button", onclick: function () { evaluate(false, reBtn); } }, "Re-evaluate");
    var rulesBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: function () { evaluate(true, rulesBtn); } }, "Rules only");
    function evaluate(rulesOnly, btn) {
      run(btn, R.api(oppPath(ctx.id, "/evaluate"), { body: { rulesOnly: rulesOnly } }), "Evaluation updated.", status).then(function (r) { if (r) { ctx.reload(); loadSummary(); } });
    }
    var bars = el("div", { class: "stack", style: "gap:6px" }, [["Legitimacy", o.legitimacyScore], ["Scam risk", o.scamRiskScore, true], ["Relevance", o.relevanceScore], ["Remote eligibility", o.remoteEligibilityScore]]
      .map(function (s) { return el("div", { class: "score-row" }, [el("span", { class: "faint" }, s[0]), R.scoreBar(s[0], s[1], !!s[2])]); }));
    return R.section("Scores & verification", [
      el("div", { class: "row between", style: "align-items:flex-start" }, [bars, R.advisoryChip()]),
      h4("Why: " + R.label("verificationStatus", o.verificationStatus)),
      R.list(o.verificationReasons, "No verification reasons recorded yet — run an evaluation."),
      h4("Signals"), signalList(o.scamSignals),
      ev ? aiBlock(ev) : faint("Not evaluated yet."),
      el("div", { class: "row", style: "margin-top:12px" }, [reBtn, rulesBtn, el("span", { class: "small faint" }, "Rules always run; the local model is used when reachable.")]), status,
    ]);
  }
  function signalList(items) {
    if (!items || !items.length) return faint("No signals recorded.");
    return el("div", null, items.map(function (s) {
      return el("div", { class: "signal" }, [R.badgeFor(s.kind, "signalKind"), el("div", null, [s.message,
        s.evidence ? el("div", { class: "ev" }, "“" + s.evidence + "”") : null,
        el("div", { class: "ev" }, s.code + (s.weight ? " · " + (s.kind === "risk" ? "−" : "+") + s.weight : ""))])]);
    }));
  }
  function aiBlock(ev) {
    var meta = [ev.provider, ev.model, ev.promptVersion ? "prompt " + ev.promptVersion : null, R.fmtDateTime(ev.createdAt)].filter(Boolean).join(" · ");
    if (!ev.ai) {
      return el("div", { class: "notice", style: "margin-top:12px" }, [R.badgeFor(ev.aiStatus, "aiStatus"), " Model output was not used" + (ev.aiError ? ": " + ev.aiError : ".") + " Rules-based scores above still apply.", el("div", { class: "small faint" }, meta)]);
    }
    var a = ev.ai;
    return el("div", { class: "card", style: "margin-top:12px" }, [
      el("div", { class: "row between" }, [el("h4", { class: "small", style: "margin:0" }, "AI assessment"), el("span", { class: "row" }, [R.badgeFor(a.confidence, "confidence"), R.advisoryChip()])]),
      el("p", { style: "margin:8px 0" }, a.rationale),
      a.suggestedNextAction ? el("p", { class: "small", style: "margin:0 0 8px" }, [el("strong", null, "Suggested next action: "), a.suggestedNextAction]) : null,
      (a.evidence || []).length ? [el("h4", { class: "small" }, "Evidence"), R.evidenceList(a.evidence)] : null,
      (a.riskSignals || []).length ? [h4("Risk signals"), R.list(a.riskSignals)] : null,
      (a.missingInformation || []).length ? [h4("Missing information"), R.list(a.missingInformation)] : null,
      el("p", { class: "small faint", style: "margin:8px 0 0" }, meta),
    ]);
  }
  function secDetails(ctx) {
    var o = ctx.d.opportunity, c = o.compensation || {};
    var range = [c.min, c.max].filter(function (n) { return typeof n === "number"; }).join("–");
    var comp = c.text || (range ? range + (c.currency ? " " + c.currency : "") + (c.period && c.period !== "UNKNOWN" ? " / " + c.period.toLowerCase() : "") : null);
    return R.section("Details", [
      R.kv([["Employment", R.label("employmentType", o.employmentType)], ["Location", o.locationText], ["Eligible countries", o.eligibleCountries], ["Timezone", o.timezoneRequirements],
        ["Compensation", comp], ["Posted", o.postedAt ? R.fmtDate(o.postedAt) : null], ["Discovered", R.fmtDateTime(o.discoveredAt)], ["Closes", o.closesAt ? R.fmtDate(o.closesAt) : null],
        ["Source", o.sourceName + " (" + R.label("sourceType", o.sourceType) + ")"], ["External id", o.externalId], ["Canonical URL", o.canonicalUrl ? R.linkOut(o.canonicalUrl) : null]]),
      h4("Responsibilities"), R.list(o.responsibilities), h4("Qualifications"), R.list(o.qualifications),
      h4("Required skills"), R.tags(o.requiredSkills), h4("Preferred skills"), R.tags(o.preferredSkills),
      el("details", { style: "margin-top:12px" }, [el("summary", null, "Normalized description (" + (o.normalizedDescription || "").length + " chars)"), el("pre", { style: "margin-top:8px" }, o.normalizedDescription || "—")]),
      h4("Seen at"),
      ctx.d.sources.length ? el("div", null, ctx.d.sources.map(function (s) {
        return el("div", { class: "evidence" }, [s.sourceName + " · " + R.label("sourceType", s.sourceType) + " · " + R.fmtDateTime(s.seenAt),
          el("div", { class: "fact" }, [s.sourceUrl ? R.linkOut(s.sourceUrl) : "no URL", s.externalId ? " · id " + s.externalId : null])]);
      })) : faint("No source sightings recorded."),
    ]);
  }
  function secResume(ctx) {
    var o = ctx.d.opportunity, rec = ctx.d.recommendedResume, status = statusLine();
    var sel = R.select(resumeOptions("— none —"), o.recommendedResumeId || "");
    var save = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      run(save, R.api(oppPath(ctx.id), { method: "PATCH", body: { recommendedResumeId: sel.value || null } }), "Recommended résumé updated.", status).then(function (r) { if (r) ctx.reload(); });
    } }, "Save choice");
    return R.section("Résumé recommendation", [
      rec ? el("div", { class: "card" }, [
        el("div", { class: "row between" }, [el("strong", null, rec.label), R.badgeFor(rec.extractionStatus, "extractionStatus")]),
        R.kv([["File", rec.filename], ["Target roles", rec.targetRoles], ["Top skills", (rec.skills || []).slice(0, 10)]]),
        el("div", { class: "score-row", style: "margin-top:6px" }, [el("span", { class: "faint" }, "Extraction quality"), R.scoreBar("Extraction quality", rec.extractionQuality)]),
      ]) : faint((cache.resumes || []).length ? "No résumé recommended yet — run an evaluation or choose one below." : "No résumés indexed. Open the Résumé Library to index your folder."),
      o.matchRationale ? el("p", { class: "small", style: "margin:8px 0 0" }, [el("strong", null, "Match rationale: "), o.matchRationale]) : null,
      el("div", { style: "margin-top:10px" }, R.field("Override recommendation", sel)),
      el("div", { class: "row" }, [save, el("a", { href: "/opportunity-radar/resumes", class: "small" }, "Manage résumés →")]), status,
    ]);
  }
  function secWorkspace(ctx) {
    var d = ctx.d, app = d.application, status = statusLine();
    ctx.resumeSelect = R.select(resumeOptions("Use recommended / first active"), (app && app.resumeId) || d.opportunity.recommendedResumeId || "");
    var questions = R.textarea({ rows: 3, placeholder: "One application question per line (max 10)" });
    var outreach = R.checkbox("Include recruiter outreach note"), templateOnly = R.checkbox("Template only (skip the model)");
    var gen = el("button", { class: "btn btn-sm", type: "submit" }, "Generate draft package");
    var form = el("form", { onsubmit: function (e) {
      e.preventDefault();
      var body = { questions: R.parseLines(questions.value).slice(0, 10), includeOutreach: outreach.input.checked, templateOnly: templateOnly.input.checked };
      if (ctx.resumeSelect.value) body.resumeId = ctx.resumeSelect.value;
      status.textContent = "Drafting… the local model can take a minute.";
      run(gen, R.api(oppPath(ctx.id, "/generate-draft"), { body: body }), "Draft package generated — review every line.", status).then(function (r) {
        if (r) { ctx.draftVersion = r.draft ? r.draft.version : null; ctx.reload(); }
      });
    } }, [
      R.field("Résumé to draft from", ctx.resumeSelect), R.field("Application questions", questions),
      el("div", { class: "row", style: "margin-bottom:10px" }, [outreach.label, templateOnly.label]),
      el("div", { class: "row" }, [gen, el("span", { class: "small faint" }, "Grounded in the selected résumé only. Nothing is sent anywhere.")]), status,
    ]);
    var drafts = packageDrafts(d), panel = el("div", { style: "margin-top:14px" });
    if (drafts.length) renderDraftPanel(ctx, drafts, panel); else panel.appendChild(faint("No draft package yet."));
    return R.section("Application workspace", [
      app ? R.kv([["Application", R.badgeFor(app.status, "applicationStatus")], ["Draft version", String(app.currentDraftVersion || 0)],
        ["Approved", app.approvedAt ? R.fmtDateTime(app.approvedAt) + " (v" + app.approvedDraftVersion + ")" : null], ["Applied", app.appliedAt ? R.fmtDateTime(app.appliedAt) : null]]) : null,
      form, panel,
    ]);
  }
  function renderDraftPanel(ctx, drafts, panel) {
    R.clear(panel);
    var sel = drafts.filter(function (x) { return x.version === ctx.draftVersion; })[0] || drafts[0];
    ctx.draftVersion = sel.version;
    var c = sel.content || {}, f = {}, status = statusLine();
    function block(text, key, value, rows) {
      var ta = R.textarea({ rows: rows, id: R.uid("d") });
      ta.value = value || ""; f[key] = ta;
      return el("div", { class: "field" }, [el("div", { class: "row between" }, [el("label", { for: ta.id, style: "margin:0" }, text), R.copyBtn(function () { return ta.value; })]), ta]);
    }
    var answers = (c.applicationAnswers || []).map(function (qa) {
      var ta = R.textarea({ rows: 3, "aria-label": "Answer: " + qa.question });
      ta.value = qa.answer || "";
      return { question: qa.question, ta: ta };
    });
    var save = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      var body = { professionalSummary: f.professionalSummary.value.trim(), coverLetter: f.coverLetter.value.trim(), resumeTailoringSuggestions: R.parseLines(f.resumeTailoringSuggestions.value),
        applicationAnswers: answers.map(function (a) { return { question: a.question, answer: a.ta.value.trim() }; }), recruiterOutreach: f.recruiterOutreach.value.trim() || null };
      run(save, R.api(oppPath(ctx.id, "/drafts/" + encodeURIComponent(sel.id)), { method: "PATCH", body: body }), "Saved as a new draft version.", status).then(function (r) {
        if (r) { ctx.draftVersion = r.draft ? r.draft.version : null; ctx.reload(); }
      });
    } }, "Save edits");
    var versionSel = R.select(drafts.map(function (x) { return [String(x.version), "v" + x.version + " · " + x.generatedBy + " · " + R.fmtDate(x.createdAt)]; }), String(sel.version), { "aria-label": "Draft version", style: "width:auto" });
    versionSel.addEventListener("change", function () { ctx.draftVersion = Number(versionSel.value); renderDraftPanel(ctx, drafts, panel); });
    var meta = ["v" + sel.version, "by " + sel.generatedBy, sel.model || sel.provider, sel.promptVersion ? "prompt " + sel.promptVersion : null, R.fmtDateTime(sel.createdAt), sel.editedAt ? "edited " + R.fmtDateTime(sel.editedAt) : null].filter(Boolean).join(" · ");
    R.append(panel, [
      el("div", { class: "row between" }, [el("h4", { class: "small", style: "margin:0" }, "Draft package"), drafts.length > 1 ? versionSel : el("span", { class: "small faint" }, "v" + sel.version)]),
      el("p", { class: "small faint", style: "margin:4px 0 10px" }, [meta, " · ", R.advisoryChip()]),
      (sel.groundingWarnings || []).length ? el("div", { class: "notice hot", style: "margin-bottom:10px" }, [el("strong", null, "Grounding warnings"), R.list(sel.groundingWarnings)]) : null,
      block("Professional summary", "professionalSummary", c.professionalSummary, 4),
      block("Cover letter", "coverLetter", c.coverLetter, 12),
      block("Résumé tailoring suggestions (one per line)", "resumeTailoringSuggestions", (c.resumeTailoringSuggestions || []).join("\n"), 5),
      answers.length ? el("div", { class: "field" }, [
        el("div", { class: "row between" }, [el("span", { class: "label" }, "Application answers"), R.copyBtn(function () { return answers.map(function (a) { return "Q: " + a.question + "\nA: " + a.ta.value; }).join("\n\n"); })]),
        answers.map(function (a) { return [el("p", { class: "answer-q" }, a.question), a.ta]; }),
      ]) : null,
      block("Recruiter outreach (optional)", "recruiterOutreach", c.recruiterOutreach, 6),
      el("div", { class: "row" }, [save, el("span", { class: "small faint" }, "Edits are stored as a new version; earlier versions stay in history.")]), status,
      el("h4", { class: "small", style: "margin-top:14px" }, "Evidence — each claim and the résumé fact behind it"),
      R.evidenceList(c.evidence, "No evidence items — treat every claim as unverified until you check it against your résumé."),
    ]);
  }
  function secApproval(ctx) {
    var d = ctx.d, app = d.application, drafts = packageDrafts(d), status = statusLine(), kids = [];
    if (isApproved(ctx)) {
      kids.push(el("div", { class: "notice teal" }, "Approved " + R.fmtDateTime(app.approvedAt) + " (draft v" + app.approvedDraftVersion + ")."));
      if (ctx.approval && ctx.approval.checklist) kids.push(el("div", null, [h4("Checklist"), R.list(ctx.approval.checklist)]));
      kids.push(el("div", { style: "margin-top:10px" }, openOfficial((ctx.approval && ctx.approval.applicationUrl) || applicationUrlFor(d.opportunity))));
      kids.push(el("div", { class: "notice hot", style: "margin-top:10px" }, "Nothing is submitted by Opportunity Radar. Submit on the employer's site, then record it below."));
    }
    if (!drafts.length) kids.push(faint("Generate a draft package first."));
    else {
      var version = ctx.draftVersion || drafts[0].version;
      var ack = R.checkbox("I have reviewed and edited this material and approve it for my own submission");
      var btn = el("button", { class: "btn btn-sm", type: "button", disabled: true, onclick: function () {
        var body = { acknowledged: true, draftVersion: version };
        if (ctx.resumeSelect && ctx.resumeSelect.value) body.resumeId = ctx.resumeSelect.value;
        run(btn, R.api(oppPath(ctx.id, "/approve"), { body: body }), "Approved for your own submission.", status).then(function (r) { if (r) { ctx.approval = r; ctx.reload(); } });
      } }, "Approve for application");
      ack.input.addEventListener("change", function () { btn.disabled = !ack.input.checked; });
      kids.push(el("div", { style: "margin-top:10px" }, [ack.label, el("div", { class: "row", style: "margin-top:8px" }, [btn, el("span", { class: "small faint" }, "Approves draft v" + version + " with the résumé selected above.")]), status]));
    }
    return R.section("Approval", kids);
  }
  function secApplied(ctx) {
    var app = ctx.d.application, status = statusLine();
    var date = R.input({ type: "date", value: R.today() }), ref = R.input({ maxlength: 300 }), days = R.input({ type: "number", min: 0, max: 365, value: String(cache.followUpDays) }), notes = R.textarea({ rows: 2 });
    var btn = el("button", { class: "btn btn-sm", type: "submit" }, "Record as applied");
    var form = el("form", { onsubmit: function (e) {
      e.preventDefault();
      var body = { appliedAt: date.value || R.today(), confirmationReference: ref.value.trim() || null, notes: notes.value.trim() };
      var n = R.numberOrUndefined(days.value);
      if (n !== undefined) body.followUpDays = n;
      run(btn, R.api(oppPath(ctx.id, "/mark-applied"), { body: body }), "Recorded — follow-up scheduled.", status).then(function (r) { if (r) { ctx.reload(); loadSummary(); } });
    } }, [
      el("div", { class: "grid cols-2" }, [R.field("Applied on", date), R.field("Confirmation reference", ref)]),
      el("div", { class: "grid cols-2" }, [R.field("Follow up in (days)", days, "Default from Settings."), R.field("Notes", notes)]),
      el("div", { class: "row" }, [btn, el("span", { class: "small faint" }, "Only after you submitted on the employer's site. Requires an approved draft.")]), status,
    ]);
    var applied = app && app.appliedAt;
    return R.section("Applied", [
      applied ? R.kv([["Applied", R.fmtDateTime(app.appliedAt)], ["Reference", app.confirmationReference], ["Follow-up due", app.followUpDueAt ? R.fmtDate(app.followUpDueAt) + " (" + R.relTime(app.followUpDueAt) + ")" : null], ["Notes", app.notes]]) : null,
      applied ? el("details", { style: "margin-top:10px" }, [el("summary", null, "Update the applied record"), form]) : form,
    ]);
  }
  function secFollowUp(ctx) {
    var d = ctx.d, status = statusLine();
    var items = (d.followUps || []).slice().sort(function (a, b) { return Date.parse(b.dueAt) - Date.parse(a.dueAt); });
    var listEl = items.length ? el("ul", { class: "plain" }, items.map(function (t) {
      var due = t.status === "PENDING" && R.isDue(t.dueAt);
      return el("li", null, [el("div", { class: "row between" }, [el("span", { class: due ? "hot" : null }, R.fmtDate(t.dueAt) + " · " + R.relTime(t.dueAt) + (due ? " · due" : "")), R.badgeFor(t.status, "followUpStatus")]),
        t.note ? el("div", { class: "small muted" }, t.note) : null, t.completedAt ? el("div", { class: "small faint" }, "Completed " + R.fmtDateTime(t.completedAt)) : null]);
    })) : faint("No follow-ups scheduled.");
    var draftBtn = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      status.textContent = "Drafting…";
      run(draftBtn, R.api(oppPath(ctx.id, "/follow-up-draft"), { body: {} }), "Follow-up email drafted (never sent by this tool).", status).then(function (r) { if (r) { ctx.followUpDraft = r.draft; ctx.reload(); } });
    } }, "Draft follow-up email");
    var doneNote = R.input({ placeholder: "Note (optional)", maxlength: 5000 });
    var doneBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: function () {
      run(doneBtn, R.api(oppPath(ctx.id, "/complete-follow-up"), { body: { note: doneNote.value.trim() } }), "Follow-up marked done.", status).then(function (r) { if (r) { ctx.reload(); loadSummary(); } });
    } }, "Mark follow-up done");
    var days = R.input({ type: "number", min: 0, max: 365, placeholder: "days" }), date = R.input({ type: "date" }), note = R.input({ placeholder: "Note (optional)", maxlength: 5000 });
    var resBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: function () {
      var body = { note: note.value.trim() }, n = R.numberOrUndefined(days.value);
      if (date.value) body.dueAt = date.value; else if (n !== undefined) body.days = n; else { status.textContent = "Enter a number of days or pick a date."; return; }
      run(resBtn, R.api(oppPath(ctx.id, "/schedule-follow-up"), { body: body }), "Follow-up rescheduled.", status).then(function (r) { if (r) { ctx.reload(); loadSummary(); } });
    } }, "Reschedule");
    var fud = ctx.followUpDraft || followUpDrafts(d)[0] || null;
    return R.section("Follow-up", [
      listEl, el("div", { class: "row", style: "margin-top:10px" }, [draftBtn]), fud ? followUpDraftView(fud) : null,
      el("div", { class: "field-inline", style: "margin-top:10px" }, [R.field("Completion note", doneNote), el("div", { style: "flex:0 0 auto;margin-bottom:12px" }, doneBtn)]),
      el("div", { class: "field-inline" }, [R.field("In days", days), R.field("Or on date", date), R.field("Note", note), el("div", { style: "flex:0 0 auto;margin-bottom:12px" }, resBtn)]),
      status,
    ]);
  }
  function followUpDraftView(x) {
    var c = x.content || {}, subj = R.input({ value: c.subject || "", id: R.uid("s") }), body = R.textarea({ rows: 8, id: R.uid("b") });
    body.value = c.body || "";
    return el("div", { class: "card", style: "margin-top:10px" }, [
      el("div", { class: "row between" }, [el("h4", { class: "small", style: "margin:0" }, "Follow-up email draft v" + x.version), R.advisoryChip()]),
      el("div", { class: "row between", style: "margin-top:8px" }, [el("label", { for: subj.id, style: "margin:0" }, "Subject"), R.copyBtn(function () { return subj.value; })]), subj,
      el("div", { class: "row between", style: "margin-top:8px" }, [el("label", { for: body.id, style: "margin:0" }, "Body"), R.copyBtn(function () { return body.value; })]), body,
      el("p", { class: "small faint", style: "margin:8px 0" }, "Never sent by this tool. Read it, then copy it into your own mail client."),
      (x.groundingWarnings || []).length ? el("div", { class: "notice hot", style: "margin-bottom:8px" }, R.list(x.groundingWarnings)) : null,
      R.evidenceList(c.evidence, "No evidence items."),
    ]);
  }
  function secStatus(ctx) {
    var o = ctx.d.opportunity, status = statusLine();
    var sel = R.select(R.enumOptions("status"), o.status), note = R.input({ placeholder: "Note (optional)", maxlength: 5000 });
    var btn = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      run(btn, R.api(oppPath(ctx.id, "/status"), { body: { status: sel.value, note: note.value.trim() } }), "Status changed.", status).then(function (r) { if (r) { ctx.reload(); refreshAll(); } });
    } }, "Change status");
    var del = el("button", { class: "btn btn-hot btn-sm", type: "button", onclick: function () {
      R.confirm("Delete “" + o.title + "” at " + o.companyName + "? Its evaluations, drafts and follow-ups go with it.", { danger: true, confirmLabel: "Delete", title: "Delete opportunity" }).then(function (ok) {
        if (!ok) return;
        run(del, R.api(oppPath(ctx.id), { method: "DELETE" }), "Deleted.", status).then(function (r) { if (r) { ctx.drawer.close(); refreshAll(); } });
      });
    } }, "Delete");
    return R.section("Status", [
      el("div", { class: "field-inline" }, [R.field("Status", sel), R.field("Note", note), el("div", { style: "flex:0 0 auto;margin-bottom:12px" }, btn)]),
      el("div", { class: "row" }, [del, el("span", { class: "small faint" }, "Permanent. Résumé files are never touched.")]), status,
    ]);
  }
  function secNotes(ctx) {
    var o = ctx.d.opportunity, status = statusLine(), ta = R.textarea({ rows: 3, placeholder: "Add a note…" });
    var btn = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      var t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      run(btn, R.api(oppPath(ctx.id, "/notes"), { body: { note: t } }), "Note added.", status).then(function (r) { if (r) ctx.reload(); });
    } }, "Add note");
    var audit = (ctx.d.audit || []).slice().sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
    return R.section("Notes & timeline", [
      o.notes ? el("pre", { style: "margin-bottom:10px" }, o.notes) : null,
      R.field("New note", ta), el("div", { class: "row" }, [btn]), status,
      el("h4", { class: "small", style: "margin-top:14px" }, "Timeline"),
      audit.length ? el("ol", { class: "timeline" }, audit.map(function (a) {
        return el("li", null, [el("time", { datetime: a.createdAt }, R.fmtDateTime(a.createdAt)), el("span", null, [el("strong", null, R.humanize(a.event)), " ", el("span", { class: "muted small" }, auditDetail(a))])]);
      })) : faint("No events yet."),
    ]);
  }
  function auditDetail(a) {
    var d = a.detail || {}, parts = [];
    Object.keys(d).slice(0, 4).forEach(function (k) {
      var v = d[k];
      if (v === null || v === undefined || typeof v === "object") return;
      var s = String(v);
      parts.push(k + ": " + (s.length > 60 ? s.slice(0, 57) + "…" : s));
    });
    return (parts.join(" · ") + (a.actor ? " — " + a.actor : "")).slice(0, 180);
  }

  /* ---------- init ---------- */
  function openFromHash() {
    var m = /^#opportunity=([^&]+)/.exec(location.hash);
    if (!m) return;
    var id = decodeURIComponent(m[1]);
    if (!current || current.id !== id) openDetail(id);
  }
  function init() {
    R.nav("radar");
    fillSelect("f-status", "status"); fillSelect("f-sourceType", "sourceType", "Any"); fillSelect("f-workMode", "workMode", "Any");
    fillSelect("f-geo", "geographicEligibility", "Any"); fillSelect("f-verification", "verificationStatus", "Any");
    applyParams(new URLSearchParams(location.search));
    var filters = $("filters"), reset = function () { state.offset = 0; loadList(); }, debounced = R.debounce(reset, 350);
    filters.addEventListener("submit", function (e) { e.preventDefault(); reset(); });
    filters.addEventListener("input", function (e) { if (e.target.tagName === "INPUT" && e.target.type !== "date") debounced(); });
    filters.addEventListener("change", function (e) { if (e.target.tagName === "SELECT" || e.target.type === "date") reset(); });
    $("btn-clear").addEventListener("click", function () { filters.reset(); Array.prototype.forEach.call($("f-status").options, function (o) { o.selected = false; }); reset(); });
    Array.prototype.forEach.call(document.querySelectorAll("th[data-sort] button"), function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.parentNode.getAttribute("data-sort");
        if (state.sort === key) state.order = state.order === "asc" ? "desc" : "asc";
        else { state.sort = key; state.order = TEXT_SORT[key] ? "asc" : "desc"; }
        reset();
      });
    });
    $("btn-prev").addEventListener("click", function () { state.offset = Math.max(0, state.offset - LIMIT); loadList(); });
    $("btn-next").addEventListener("click", function () { state.offset += LIMIT; loadList(); });
    $("btn-refresh").addEventListener("click", function () { cache.resumes = null; refreshAll().then(function () { R.toast("Refreshed."); }); });
    $("btn-add-manual").addEventListener("click", function () { loadResumes().then(openManualForm); });
    $("btn-sources").addEventListener("click", openSources);
    var addBtn = $("btn-add-url"), addForm = $("add-url-form");
    function toggleAdd(show) { addForm.hidden = !show; addBtn.setAttribute("aria-expanded", show ? "true" : "false"); (show ? $("add-url") : addBtn).focus(); }
    addBtn.addEventListener("click", function () { toggleAdd(addForm.hidden); });
    $("add-url-cancel").addEventListener("click", function () { toggleAdd(false); });
    addForm.addEventListener("submit", onAddUrl);
    $("link-export").addEventListener("click", function (e) {
      if (!R.getToken()) return; // a plain link works when no token is configured
      e.preventDefault();
      R.download(e.currentTarget.href, "opportunities.csv").catch(function (err) { R.toast(R.errorText(err), "bad"); });
    });
    R.api("/settings").then(function (s) {
      var n = s.overrides && s.overrides.followUpDays;
      if (typeof n !== "number") n = s.config && s.config.followUpDays;
      if (typeof n === "number") cache.followUpDays = n;
    }).catch(function () {});
    refreshAll();
    window.addEventListener("hashchange", openFromHash);
    openFromHash();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
