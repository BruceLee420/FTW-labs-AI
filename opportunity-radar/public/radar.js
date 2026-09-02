/**
 * Opportunity Radar — shared browser helpers, exposed as window.Radar.
 *
 * Loaded by every page under /opportunity-radar/. Provides the API client
 * (request marker header, bearer token, one-time token prompt on 401, error
 * normalisation), DOM builders that only ever assign textContent (listing text
 * and model output can never inject markup), formatters, enum label maps, the
 * site header, drawer/modal overlays (focus trap, Escape, focus return), an
 * aria-live toast and small form helpers. Vanilla JS — no build step.
 */
(function () {
  "use strict";
  if (window.Radar) return;

  var API_BASE = "/api/opportunity-radar";
  var TOKEN_KEY = "ftw_radar_token";
  var ADVISORY = "Advisory — review before acting";
  var PROPS = ["value", "checked", "disabled", "selected", "hidden", "multiple", "required", "readOnly", "open", "indeterminate"];
  var seq = 0;

  /* ---------- enum labels ---------- */
  var LABELS = {
    status: {
      DISCOVERED: "Discovered", NORMALIZED: "Normalized", REVIEW_NEEDED: "Review needed", VERIFIED: "Verified",
      READY_TO_APPLY: "Ready to apply", DRAFT_PREPARED: "Draft prepared", AWAITING_APPROVAL: "Awaiting approval",
      APPLIED: "Applied", FOLLOW_UP_DUE: "Follow-up due", FOLLOWED_UP: "Followed up", INTERVIEWING: "Interviewing",
      OFFER: "Offer", REJECTED: "Rejected", SKIPPED: "Skipped", CLOSED: "Closed",
    },
    verificationStatus: {
      UNVERIFIED: "Unverified", LIKELY_LEGIT: "Likely legitimate", VERIFIED_OFFICIAL_SOURCE: "Verified official source",
      NEEDS_MANUAL_REVIEW: "Needs manual verification", HIGH_RISK: "High risk", REJECTED_AS_SCAM: "Rejected as scam",
    },
    workMode: { REMOTE: "Remote", HYBRID: "Hybrid", ONSITE: "On-site", UNKNOWN: "Unknown" },
    geographicEligibility: {
      US_ONLY: "US only", US_SPECIFIC_STATES: "US — specific states", GLOBAL: "Global",
      COUNTRY_RESTRICTED: "Country-restricted", UNKNOWN: "Unknown",
    },
    sourceType: { OFFICIAL_ATS: "Official ATS", JOB_BOARD: "Job board", MANUAL_URL: "Manual URL", RSS: "RSS feed", REFERRAL: "Referral" },
    employmentType: {
      FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract", TEMPORARY: "Temporary",
      INTERNSHIP: "Internship", FREELANCE: "Freelance", UNKNOWN: "Unknown",
    },
    extractionStatus: {
      OK: "Text OK", POOR: "Poor extraction", NEEDS_OCR: "Needs OCR", FAILED: "Failed",
      UNSUPPORTED: "Unsupported format", MISSING_FILE: "File missing",
    },
    applicationStatus: { DRAFTING: "Drafting", AWAITING_APPROVAL: "Awaiting approval", APPROVED: "Approved", SUBMITTED: "Submitted", WITHDRAWN: "Withdrawn" },
    followUpStatus: { PENDING: "Pending", DONE: "Done", CANCELLED: "Cancelled" },
    aiStatus: { OK: "AI OK", UNAVAILABLE: "AI unavailable", INVALID_OUTPUT: "AI output rejected", ERROR: "AI error", DISABLED: "AI disabled" },
    syncStatus: { RUNNING: "Running", SUCCESS: "Success", PARTIAL: "Partial", FAILED: "Failed" },
    signalKind: { risk: "Risk", positive: "Positive", info: "Info" },
    confidence: { low: "Low confidence", medium: "Medium confidence", high: "High confidence" },
  };
  var BADGE = {
    LIKELY_LEGIT: "ok", VERIFIED_OFFICIAL_SOURCE: "ok", NEEDS_MANUAL_REVIEW: "warn", HIGH_RISK: "bad", REJECTED_AS_SCAM: "bad",
    REVIEW_NEEDED: "warn", VERIFIED: "ok", READY_TO_APPLY: "ok", DRAFT_PREPARED: "ink", AWAITING_APPROVAL: "warn",
    APPLIED: "ink", FOLLOW_UP_DUE: "warn", FOLLOWED_UP: "ink", INTERVIEWING: "ok", OFFER: "ok", REJECTED: "bad",
    OK: "ok", POOR: "warn", NEEDS_OCR: "bad", FAILED: "bad", UNSUPPORTED: "warn", MISSING_FILE: "bad",
    APPROVED: "ok", SUBMITTED: "ink", PENDING: "warn", DONE: "ok", SUCCESS: "ok", PARTIAL: "warn",
    UNAVAILABLE: "warn", INVALID_OUTPUT: "bad", ERROR: "bad", risk: "bad", positive: "ok", high: "ok", medium: "warn", low: "bad",
  };
  var LOOKUP = ["verificationStatus", "status", "extractionStatus", "applicationStatus", "followUpStatus", "syncStatus", "aiStatus",
    "workMode", "geographicEligibility", "sourceType", "employmentType", "signalKind", "confidence"];

  function humanize(v) {
    if (v === null || v === undefined || v === "") return "—";
    var s = String(v).replace(/_/g, " ").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function label(map, value) { var m = LABELS[map]; return (m && m[value]) || humanize(value); }
  function findLabel(value) {
    for (var i = 0; i < LOOKUP.length; i++) { var m = LABELS[LOOKUP[i]]; if (m[value]) return m[value]; }
    return humanize(value);
  }
  function enumOptions(map, emptyLabel) {
    var out = emptyLabel !== undefined ? [["", emptyLabel]] : [];
    Object.keys(LABELS[map]).forEach(function (k) { out.push([k, LABELS[map][k]]); });
    return out;
  }

  /* ---------- DOM ---------- */
  function uid(prefix) { seq += 1; return (prefix || "r") + "-" + seq; }
  function esc(text) {
    return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function append(node, children) {
    if (children === null || children === undefined || children === false) return node;
    if (Array.isArray(children)) { children.forEach(function (c) { append(node, c); }); return node; }
    node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
    return node;
  }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") node.textContent = String(v);
      else if (k === "class") { if (v) node.className = v; }
      else if (typeof v === "function" && k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else if (PROPS.indexOf(k) !== -1) node[k] = v;
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    });
    return append(node, children);
  }
  function clear(node) { node.textContent = ""; return node; }

  /* ---------- formatting ---------- */
  function parseDate(iso) { var t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? null : new Date(t); }
  function fmtDate(iso) { var d = parseDate(iso); return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"; }
  function fmtDateTime(iso) {
    var d = parseDate(iso);
    return d ? d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  }
  var rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
  function relTime(iso) {
    var d = parseDate(iso);
    if (!d) return "—";
    var diff = d.getTime() - Date.now(), abs = Math.abs(diff);
    if (abs < 45e3) return "just now";
    var units = [["year", 31536e6], ["month", 2592e6], ["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][1] || i === units.length - 1) {
        var n = Math.round(diff / units[i][1]);
        if (rtf) return rtf.format(n, units[i][0]);
        var u = units[i][0] + (Math.abs(n) === 1 ? "" : "s");
        return n < 0 ? -n + " " + u + " ago" : "in " + n + " " + u;
      }
    }
    return "—";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function toDateInput(iso) {
    var d = iso === undefined ? new Date() : parseDate(iso);
    return d ? d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) : "";
  }
  function today() { return toDateInput(undefined); }
  function isDue(iso) { var d = parseDate(iso); return !!d && d.getTime() <= Date.now(); }

  /* ---------- storage / token ---------- */
  function storageGet(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
  function storageSet(store, key, value) {
    try { if (value) window[store].setItem(key, value); else window[store].removeItem(key); return true; } catch (e) { return false; }
  }
  function getToken() { return storageGet("sessionStorage", TOKEN_KEY) || storageGet("localStorage", TOKEN_KEY) || ""; }
  function setToken(value, persist) {
    storageSet("sessionStorage", TOKEN_KEY, value);
    if (persist || !value) storageSet("localStorage", TOKEN_KEY, value);
  }

  /* ---------- API client ---------- */
  function buildQuery(q) {
    if (!q) return "";
    var sp = new URLSearchParams();
    Object.keys(q).forEach(function (k) {
      var v = q[k];
      if (v === undefined || v === null || v === "") return;
      if (Array.isArray(v)) v.forEach(function (x) { if (x !== "" && x !== null && x !== undefined) sp.append(k, String(x)); });
      else sp.append(k, String(v));
    });
    var s = sp.toString();
    return s ? "?" + s : "";
  }
  function apiError(message, status, code, issues) {
    var e = new Error(message);
    e.status = status; e.code = code || null; e.issues = Array.isArray(issues) ? issues : [];
    return e;
  }
  function api(path, opts) {
    opts = opts || {};
    var hasBody = opts.body !== undefined;
    var headers = { "X-Radar-Request": "1", Accept: "application/json" };
    if (hasBody) headers["Content-Type"] = "application/json";
    var tok = getToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    var init = { method: (opts.method || (hasBody ? "POST" : "GET")).toUpperCase(), headers: headers };
    if (hasBody) init.body = JSON.stringify(opts.body);
    return fetch(API_BASE + path + buildQuery(opts.query), init).catch(function () {
      throw apiError("Opportunity Radar service is offline — run `npm start` in opportunity-radar/.", 0, "offline");
    }).then(function (r) {
      if (r.status === 401 && !opts.retried) {
        return askToken().then(function (t) {
          if (!t) throw apiError("An access token is required. Enter it under Settings → Access token.", 401, "unauthorized");
          return api(path, Object.assign({}, opts, { retried: true }));
        });
      }
      if (r.status === 204) return {};
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var msg = (data && data.error) || (r.status === 401 ? "Unauthorized — check the access token under Settings." : "Request failed (" + r.status + ").");
          throw apiError(msg, r.status, data && data.code, data && data.issues);
        }
        return data === null ? {} : data;
      });
    });
  }
  function errorText(err) {
    if (!err) return "Unknown error.";
    var msg = err.message || String(err);
    var issues = (err.issues || []).map(function (i) {
      if (typeof i === "string") return i;
      return (i.path ? i.path + ": " : "") + (i.message || "");
    }).filter(Boolean);
    return issues.length ? msg + " — " + issues.join("; ") : msg;
  }
  var tokenPrompt = null;
  function askToken() {
    if (tokenPrompt) return tokenPrompt;
    tokenPrompt = new Promise(function (resolve) {
      var m;
      var inputEl = input({ type: "password", autocomplete: "off", spellcheck: "false" });
      var form = el("form", {
        class: "stack",
        onsubmit: function (e) {
          e.preventDefault();
          var v = inputEl.value.trim();
          if (!v) { inputEl.focus(); return; }
          setToken(v, false); resolve(v); m.close();
        },
      }, [
        el("p", { class: "small muted", style: "margin:0" }, "This service is protected with OPPORTUNITY_RADAR_AUTH_TOKEN. Paste the token to continue. It is kept in this tab's sessionStorage and sent only to the local API."),
        field("Access token", inputEl),
        el("div", { class: "row" }, [
          el("button", { class: "btn", type: "submit" }, "Use token"),
          el("button", { class: "btn btn-ghost", type: "button", onclick: function () { m.close(); } }, "Cancel"),
        ]),
      ]);
      m = modal({ title: "Access token required", content: form, focus: inputEl, onClose: function () { resolve(null); } });
    });
    tokenPrompt.then(function () { tokenPrompt = null; }, function () { tokenPrompt = null; });
    return tokenPrompt;
  }

  /* ---------- overlays: drawer + modal ---------- */
  var overlays = [];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (n) { return !n.hidden && n.getClientRects().length > 0; });
  }
  document.addEventListener("keydown", function (e) {
    var top = overlays[overlays.length - 1];
    if (top) top.key(e);
  }, true);
  function openOverlay(panel, opts) {
    opts = opts || {};
    if (!opts.stack) overlays.slice().forEach(function (o) { o.close(); });
    var prev = document.activeElement;
    var backdrop = el("div", { class: "drawer-backdrop" + (opts.stack ? " modal-backdrop" : "") });
    var closed = false;
    var handle = {
      panel: panel,
      key: function (e) {
        if (e.key === "Escape") { e.preventDefault(); handle.close(); return; }
        if (e.key !== "Tab") return;
        var list = focusables(panel);
        if (!list.length) { e.preventDefault(); panel.focus(); return; }
        var first = list[0], last = list[list.length - 1], active = document.activeElement;
        if (!panel.contains(active)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      },
      close: function () {
        if (closed) return;
        closed = true;
        overlays = overlays.filter(function (o) { return o !== handle; });
        backdrop.remove(); panel.remove();
        if (!overlays.length) document.body.style.overflow = "";
        if (opts.onClose) opts.onClose();
        if (prev && typeof prev.focus === "function" && document.contains(prev)) prev.focus();
      },
    };
    backdrop.addEventListener("click", handle.close);
    overlays.push(handle);
    document.body.style.overflow = "hidden";
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    setTimeout(function () { (opts.focus || panel).focus(); }, 0);
    return handle;
  }
  function drawer(opts) {
    opts = opts || {};
    var titleId = uid("drawer-title");
    var heading = el("h2", { id: titleId }, opts.title || "");
    var body = append(el("div", { class: "drawer-body" }), opts.content);
    var closeBtn = el("button", { class: "btn btn-ghost btn-sm close", type: "button", "aria-label": "Close panel" }, "Close ✕");
    var panel = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" }, [closeBtn, heading, body]);
    var h = openOverlay(panel, { onClose: opts.onClose, focus: opts.focus });
    closeBtn.addEventListener("click", h.close);
    return { close: h.close, body: body, panel: panel, setTitle: function (t) { heading.textContent = t; } };
  }
  function modal(opts) {
    opts = opts || {};
    var titleId = uid("modal-title");
    var body = append(el("div", { class: "stack" }), opts.content);
    var panel = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" }, [el("h3", { id: titleId }, opts.title || ""), body]);
    var h = openOverlay(panel, { stack: true, onClose: opts.onClose, focus: opts.focus });
    return { close: h.close, body: body, panel: panel };
  }
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false, m;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var ok = el("button", { class: "btn" + (opts.danger ? " btn-hot" : ""), type: "button", onclick: function () { finish(true); m.close(); } }, opts.confirmLabel || "Confirm");
      var cancel = el("button", { class: "btn btn-ghost", type: "button", onclick: function () { m.close(); } }, "Cancel");
      m = modal({ title: opts.title || "Please confirm", content: [el("p", { style: "margin:0" }, message), el("div", { class: "row" }, [ok, cancel])], focus: cancel, onClose: function () { finish(false); } });
    });
  }

  /* ---------- toast ---------- */
  var toastEl = null, toastTimer = null;
  function ensureToast() {
    if (!toastEl) { toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite", "aria-atomic": "true" }); document.body.appendChild(toastEl); }
    return toastEl;
  }
  function toast(message, kind) {
    var t = ensureToast();
    t.className = "toast" + (kind === "bad" ? " bad" : "");
    t.textContent = "";
    clearTimeout(toastTimer);
    setTimeout(function () { t.textContent = message; }, 20);
    toastTimer = setTimeout(function () { t.textContent = ""; }, kind === "bad" ? 8000 : 4000);
  }

  /* ---------- widgets ---------- */
  function badgeFor(value, map) {
    var cls = BADGE[value] || "";
    return el("span", { class: "badge" + (cls ? " " + cls : "") }, map ? label(map, value) : findLabel(value));
  }
  function scoreBar(name, value, invert, showLabel) {
    var has = typeof value === "number" && !isNaN(value);
    var v = has ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    var tone = "";
    if (has) { var good = invert ? 100 - v : v; tone = good >= 70 ? "" : good >= 40 ? "warn" : "bad"; }
    var fill = el("i");
    fill.style.width = v + "%";
    return el("span", { class: "score" + (tone ? " " + tone : ""), role: "img", title: name, "aria-label": name + ": " + (has ? v + " of 100" : "not scored") }, [
      showLabel ? el("span", { class: "faint" }, name) : null,
      el("span", { class: "bar", "aria-hidden": "true" }, fill),
      el("b", null, has ? String(v) : "—"),
    ]);
  }
  function advisoryChip() { return el("span", { class: "advisory" }, ADVISORY); }
  function nav(active) {
    var tabs = [["radar", "Radar", "/opportunity-radar/"], ["resumes", "Résumé Library", "/opportunity-radar/resumes"],
      ["settings", "Settings", "/opportunity-radar/settings"], ["dashboard", "← Dashboard", "/"]];
    var header = document.getElementById("site-header");
    if (!header) { header = el("header", { id: "site-header" }); document.body.insertBefore(header, document.body.firstChild); }
    header.className = "site";
    clear(header).appendChild(el("div", { class: "wrap" }, [
      el("a", { class: "wordmark", href: "/opportunity-radar/" }, ["FTW ", el("span", null, "Labs"), " AI · Opportunity Radar"]),
      el("nav", { class: "tabs", "aria-label": "Opportunity Radar sections" }, tabs.map(function (t) {
        return el("a", { href: t[2], "aria-current": t[0] === active ? "page" : null }, t[1]);
      })),
      advisoryChip(),
    ]));
    return header;
  }
  function field(text, control, hint) {
    if (!control.id) control.id = uid("f");
    var hintEl = hint ? el("p", { class: "small faint", id: control.id + "-hint", style: "margin:4px 0 0" }, hint) : null;
    if (hintEl) control.setAttribute("aria-describedby", hintEl.id);
    return el("div", { class: "field" }, [el("label", { for: control.id }, text), control, hintEl]);
  }
  function input(attrs) { return el("input", Object.assign({ type: "text" }, attrs || {})); }
  function textarea(attrs) { return el("textarea", attrs || {}); }
  function select(options, value, attrs) {
    var s = el("select", attrs || {});
    options.forEach(function (o) {
      var opt = el("option", { value: o[0] }, o[1]);
      if (Array.isArray(value) ? value.indexOf(o[0]) !== -1 : o[0] === value) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }
  function selectedValues(sel) { return Array.prototype.map.call(sel.selectedOptions || [], function (o) { return o.value; }).filter(Boolean); }
  function checkbox(text, attrs) {
    var box = el("input", Object.assign({ type: "checkbox" }, attrs || {}));
    return { input: box, label: el("label", { class: "check", style: "text-transform:none;letter-spacing:0;font-family:inherit;font-size:13.5px" }, [box, el("span", null, text)]) };
  }
  function kv(pairs) {
    var dl = el("dl", { class: "kv" });
    pairs.forEach(function (p) {
      var v = p[1];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
      dl.appendChild(el("dt", null, p[0]));
      dl.appendChild(el("dd", null, Array.isArray(v) ? v.join(", ") : v));
    });
    return dl;
  }
  function tags(items) {
    if (!items || !items.length) return el("span", { class: "faint" }, "—");
    return el("div", { class: "tag-input" }, items.map(function (t) { return el("span", { class: "tag" }, String(t)); }));
  }
  function list(items, emptyText) {
    if (!items || !items.length) return el("p", { class: "faint small", style: "margin:0" }, emptyText || "—");
    return el("ul", { class: "plain" }, items.map(function (t) { return el("li", null, t); }));
  }
  function section(title, children, attrs) {
    return el("section", Object.assign({ class: "section" }, attrs || {}), [el("h3", null, title), children]);
  }
  function linkOut(url, text) {
    if (!url) return el("span", { class: "faint" }, "—");
    if (!/^https?:\/\//i.test(String(url))) return el("span", { class: "mono" }, String(url));
    return el("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "mono" }, text || String(url));
  }
  function evidenceList(items, emptyText) {
    if (!items || !items.length) return el("p", { class: "faint small", style: "margin:0" }, emptyText || "No evidence recorded.");
    return el("div", null, items.map(function (ev) {
      var grounded = ev.grounded !== false;
      return el("div", { class: "evidence" + (grounded ? "" : " ungrounded") }, [
        el("div", null, [grounded ? null : el("span", { class: "badge bad", style: "margin-right:6px" }, "Not found in résumé"), ev.claim]),
        el("div", { class: "fact" }, (ev.sourceFact !== undefined ? "Résumé fact: " : "Reference: ") + (ev.sourceFact !== undefined ? ev.sourceFact : ev.reference || "")),
      ]);
    }));
  }
  function copyBtn(getText, text) {
    return el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: function () {
      var value = getText() || "";
      var write = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(value) : Promise.reject(new Error("no clipboard"));
      write.then(function () { toast("Copied to clipboard."); }, function () { toast("Clipboard unavailable — select the text and copy manually.", "bad"); });
    } }, text || "Copy");
  }
  function busy(btn, promise) {
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    function done() { if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
    return promise.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
  }
  function debounce(fn, ms) {
    var t = null;
    return function () { var args = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, ms); };
  }
  function parseList(str) { return String(str || "").split(/[\n,]/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function parseLines(str) { return String(str || "").split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function fileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || "")); };
      reader.onerror = function () { reject(new Error("Could not read the file.")); };
      reader.readAsText(file);
    });
  }
  function numberOrUndefined(v) { var s = String(v === null || v === undefined ? "" : v).trim(); if (!s) return undefined; var n = Number(s); return isNaN(n) ? undefined : n; }

  /** Download an API resource that needs the bearer header (plain links cannot send it). */
  function download(href, filename) {
    var headers = { "X-Radar-Request": "1" };
    var tok = getToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    return fetch(href, { headers: headers }).then(function (r) {
      if (!r.ok) throw apiError("Download failed (" + r.status + ").", r.status);
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    });
  }

  document.addEventListener("DOMContentLoaded", ensureToast);

  window.Radar = {
    API_BASE: API_BASE, TOKEN_KEY: TOKEN_KEY, ADVISORY: ADVISORY, LABELS: LABELS,
    api: api, download: download, errorText: errorText, getToken: getToken, setToken: setToken, buildQuery: buildQuery,
    esc: esc, el: el, append: append, clear: clear, uid: uid,
    fmtDate: fmtDate, fmtDateTime: fmtDateTime, relTime: relTime, toDateInput: toDateInput, today: today, isDue: isDue,
    toast: toast, badgeFor: badgeFor, scoreBar: scoreBar, advisoryChip: advisoryChip, nav: nav,
    drawer: drawer, modal: modal, confirm: confirmDialog,
    label: label, humanize: humanize, enumOptions: enumOptions,
    field: field, input: input, textarea: textarea, select: select, selectedValues: selectedValues, checkbox: checkbox,
    kv: kv, tags: tags, list: list, section: section, linkOut: linkOut, evidenceList: evidenceList, copyBtn: copyBtn,
    busy: busy, debounce: debounce, parseList: parseList, parseLines: parseLines, fileText: fileText, numberOrUndefined: numberOrUndefined,
  };
})();
