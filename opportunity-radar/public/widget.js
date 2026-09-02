/**
 * Opportunity Radar — compact corner widget.
 *
 * Mounted on the FTW Labs dashboard pages (site root and /app/). It talks to
 * the LOCAL Opportunity Radar service only. When that service is not running
 * the widget stays hidden on the public site (visitors never see it) and shows
 * a small "offline" state only when the page itself is served from localhost.
 *
 *   <script src="/opportunity-radar/public/widget.js" defer data-radar-base="http://127.0.0.1:4747"></script>
 *
 * No framework, no dependencies. Keyboard accessible: the toggle is a real
 * <button> with aria-expanded, the panel is a labelled region, Escape closes.
 */
(function () {
  "use strict";
  if (window.__ftwRadarWidget) return;
  window.__ftwRadarWidget = true;

  var script = document.currentScript;
  var BASE =
    (script && script.getAttribute("data-radar-base")) ||
    safeGet("ftw_radar_base") ||
    "http://127.0.0.1:4747";
  BASE = BASE.replace(/\/+$/, "");
  var API = BASE + "/api/opportunity-radar";
  var PAGE = BASE + "/opportunity-radar/";
  var POLL_MS = 60000;
  var isLocalPage = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var forceShow = safeGet("ftw_radar_widget") === "always";

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function token() { return safeGet("ftw_radar_token") || ""; }

  var css =
    ".ftw-radar{position:fixed;right:16px;bottom:16px;z-index:9998;font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.45;color:var(--ink,#1C1A22)}" +
    ".ftw-radar *{box-sizing:border-box}" +
    ".ftw-radar-toggle{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line,#B3A98D);background:var(--paper-raised,#DFD7C0);color:var(--ink,#1C1A22);padding:8px 12px;cursor:pointer;font:600 11px/1 'IBM Plex Mono',ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;box-shadow:0 8px 24px rgba(28,26,34,.18)}" +
    ".ftw-radar-toggle:focus-visible{outline:2px solid var(--focus,#1C1A22);outline-offset:2px}" +
    ".ftw-radar-toggle svg{width:16px;height:16px;flex:none}" +
    ".ftw-radar-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--ink,#1C1A22);color:var(--paper,#E8E1CE);display:inline-flex;align-items:center;justify-content:center;font-size:10.5px}" +
    ".ftw-radar-badge.review{background:var(--gold,#A6701E);color:#fff}" +
    ".ftw-radar-dot{width:8px;height:8px;border-radius:50%;background:var(--hot,#D5294F);animation:ftwRadarPulse 1.6s ease-in-out infinite}" +
    "@keyframes ftwRadarPulse{0%,100%{opacity:1}50%{opacity:.35}}" +
    "@media (prefers-reduced-motion:reduce){.ftw-radar-dot{animation:none}}" +
    ".ftw-radar-panel{position:absolute;right:0;bottom:44px;width:min(340px,calc(100vw - 32px));background:var(--paper,#E8E1CE);border:1px solid var(--line,#B3A98D);box-shadow:0 12px 32px rgba(28,26,34,.22);padding:14px 16px;max-height:min(70vh,520px);overflow:auto}" +
    ".ftw-radar-panel[hidden]{display:none}" +
    ".ftw-radar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}" +
    ".ftw-radar-head h2{margin:0;font:800 16px/1 'Big Shoulders Display','Arial Narrow',sans-serif;text-transform:uppercase;letter-spacing:.02em}" +
    ".ftw-radar-close{all:unset;cursor:pointer;padding:4px 6px;font:600 11px 'IBM Plex Mono',monospace;color:var(--ink-soft,#55505A)}" +
    ".ftw-radar-close:focus-visible{outline:2px solid var(--focus,#1C1A22)}" +
    ".ftw-radar-counts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}" +
    ".ftw-radar-count{border:1px solid var(--line,#B3A98D);padding:8px 10px;background:var(--paper-raised,#DFD7C0)}" +
    ".ftw-radar-count b{display:block;font:900 22px/1 'Big Shoulders Display',sans-serif}" +
    ".ftw-radar-count span{font:500 10px/1.3 'IBM Plex Mono',monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint,#8A8478)}" +
    ".ftw-radar-count.due b{color:var(--hot,#D5294F)}" +
    ".ftw-radar-list{list-style:none;margin:0 0 12px;padding:0}" +
    ".ftw-radar-list li{padding:6px 0;border-top:1px dashed var(--line,#B3A98D)}" +
    ".ftw-radar-list a{color:inherit;text-decoration:none}" +
    ".ftw-radar-list .t{font-weight:600;display:block}" +
    ".ftw-radar-list .c{color:var(--ink-soft,#55505A);font-size:12px}" +
    ".ftw-radar-form{display:flex;gap:6px;margin-bottom:10px}" +
    ".ftw-radar-form input{flex:1;min-width:0;font:inherit;font-size:13px;padding:7px 8px;border:1px solid var(--line,#B3A98D);background:var(--paper,#E8E1CE);color:inherit}" +
    ".ftw-radar-btn{font:600 11px 'IBM Plex Mono',monospace;letter-spacing:.06em;text-transform:uppercase;padding:7px 10px;border:1px solid var(--ink,#1C1A22);background:var(--ink,#1C1A22);color:var(--paper,#E8E1CE);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}" +
    ".ftw-radar-btn.ghost{background:transparent;color:var(--ink,#1C1A22);border-color:var(--line,#B3A98D)}" +
    ".ftw-radar-btn:focus-visible{outline:2px solid var(--focus,#1C1A22);outline-offset:2px}" +
    ".ftw-radar-status{font:500 10.5px/1.4 'IBM Plex Mono',monospace;letter-spacing:.06em;color:var(--ink-faint,#8A8478);min-height:14px}" +
    ".ftw-radar-status.bad{color:var(--hot,#D5294F)}" +
    ".ftw-radar-note{font-size:11px;color:var(--ink-faint,#8A8478);margin:8px 0 0}" +
    "@media (prefers-color-scheme:dark){.ftw-radar{--paper:#18151C;--paper-raised:#221E28;--ink:#ECE6D6;--ink-soft:#B6AEA0;--ink-faint:#756F65;--hot:#FF5D82;--gold:#E3A94A;--line:#3C3742;--focus:#ECE6D6}}" +
    "@media (max-width:480px){.ftw-radar{right:10px;bottom:10px}}";

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 L18.5 5.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>';

  var root, toggle, panel, badge, dot, status, list, countsEl, input, timer, open = false, lastFocus = null, mounted = false;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "html") el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    root = h("div", { class: "ftw-radar", id: "ftw-radar" });
    badge = h("span", { class: "ftw-radar-badge", text: "0", "aria-hidden": "true" });
    dot = h("span", { class: "ftw-radar-dot", hidden: "" });
    toggle = h("button", {
      class: "ftw-radar-toggle", type: "button", "aria-expanded": "false", "aria-controls": "ftw-radar-panel",
      "aria-label": "Opportunity Radar", html: ICON + "<span>Radar</span>",
    });
    toggle.appendChild(badge);
    toggle.appendChild(dot);
    toggle.addEventListener("click", function () { setOpen(!open); });

    countsEl = h("div", { class: "ftw-radar-counts" });
    list = h("ul", { class: "ftw-radar-list", "aria-label": "Latest verified opportunities" });
    status = h("p", { class: "ftw-radar-status", role: "status", "aria-live": "polite" });
    input = h("input", { type: "url", placeholder: "Paste a job URL…", "aria-label": "Job URL to add", autocomplete: "off" });
    var addBtn = h("button", { class: "ftw-radar-btn", type: "submit", text: "Add" });
    var form = h("form", { class: "ftw-radar-form" }, [input, addBtn]);
    form.addEventListener("submit", onAddUrl);
    var openBtn = h("a", { class: "ftw-radar-btn ghost", href: PAGE, target: "_blank", rel: "noopener", text: "Open Opportunity Radar →" });
    var closeBtn = h("button", { class: "ftw-radar-close", type: "button", "aria-label": "Close Opportunity Radar", text: "ESC" });
    closeBtn.addEventListener("click", function () { setOpen(false); });

    panel = h("section", { class: "ftw-radar-panel", id: "ftw-radar-panel", role: "region", "aria-label": "Opportunity Radar summary", hidden: "" }, [
      h("div", { class: "ftw-radar-head" }, [h("h2", { text: "Opportunity Radar" }), closeBtn]),
      countsEl,
      h("p", { class: "ftw-radar-status", text: "Latest verified", style: "margin:0 0 2px" }),
      list,
      form,
      openBtn,
      status,
      h("p", { class: "ftw-radar-note", text: "Advisory only. Nothing is ever submitted or sent automatically." }),
    ]);

    root.appendChild(panel);
    root.appendChild(toggle);
    document.body.appendChild(root);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) { setOpen(false); toggle.focus(); } });
    document.addEventListener("click", function (e) { if (open && !root.contains(e.target)) setOpen(false); });
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) { lastFocus = document.activeElement; refresh(); setTimeout(function () { input.focus(); }, 0); }
  }

  function headers(json) {
    var hdr = { "X-Radar-Request": "1" };
    if (json) hdr["Content-Type"] = "application/json";
    var t = token();
    if (t) hdr["Authorization"] = "Bearer " + t;
    return hdr;
  }

  function fetchJson(path, opts, timeoutMs) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 4000);
    opts = opts || {};
    opts.signal = ctl.signal;
    opts.headers = Object.assign(headers(!!opts.body), opts.headers || {});
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    }).finally(function () { clearTimeout(timer); });
  }

  function render(summary) {
    var c = summary.counts || {};
    var verified = c.verified || 0, review = c.needsReview || 0, due = c.followUpsDue || 0;
    badge.textContent = String(review > 0 ? review : verified);
    badge.className = "ftw-radar-badge" + (review > 0 ? " review" : "");
    toggle.setAttribute("aria-label", "Opportunity Radar: " + verified + " verified, " + review + " need review, " + due + " follow-ups due");
    dot.hidden = due === 0;
    countsEl.innerHTML = "";
    [["Verified", verified, ""], ["Needs review", review, ""], ["Follow-ups due", due, due > 0 ? "due" : ""], ["Ready to apply", c.readyToApply || 0, ""]].forEach(function (row) {
      countsEl.appendChild(h("div", { class: "ftw-radar-count " + row[2] }, [h("b", { text: String(row[1]) }), h("span", { text: row[0] })]));
    });
    list.innerHTML = "";
    var items = summary.recentVerified || [];
    if (!items.length) list.appendChild(h("li", { class: "c", text: "No verified opportunities yet — add a URL below." }));
    items.slice(0, 5).forEach(function (o) {
      var a = h("a", { href: PAGE + "#opportunity=" + encodeURIComponent(o.id), target: "_blank", rel: "noopener" }, [
        h("span", { class: "t", text: o.title }),
        h("span", { class: "c", text: o.companyName + (o.workMode && o.workMode !== "UNKNOWN" ? " · " + o.workMode.toLowerCase() : "") }),
      ]);
      list.appendChild(h("li", null, [a]));
    });
    var ai = summary.ai || {};
    setStatus(ai.reachable ? "AI advisory: " + (ai.model || "ready") : "AI offline — rules and tracking still work.", false);
  }

  function setStatus(msg, bad) { status.textContent = msg; status.className = "ftw-radar-status" + (bad ? " bad" : ""); }

  function refresh() {
    return fetchJson("/summary").then(function (r) {
      if (!r.ok) throw new Error(r.status === 401 ? "Radar needs a token (see Settings)." : "Radar returned " + r.status);
      render(r.data);
    }).catch(function (e) {
      setStatus(e && e.message && /token/.test(e.message) ? e.message : "Opportunity Radar service is offline — run `npm start` in opportunity-radar/.", true);
      dot.hidden = true;
    });
  }

  function onAddUrl(e) {
    e.preventDefault();
    var url = (input.value || "").trim();
    if (!url) return;
    setStatus("Fetching listing…", false);
    fetchJson("/opportunities/ingest-url", { method: "POST", body: JSON.stringify({ url: url }) }, 30000).then(function (r) {
      if (!r.ok) { setStatus((r.data && r.data.error) || "Could not add that URL.", true); return; }
      input.value = "";
      var o = r.data.opportunity || {};
      setStatus((r.data.duplicate ? "Already tracked: " : "Added: ") + (o.title || "listing") + (r.data.accessBlocked ? " (needs manual details)" : ""), false);
      refresh();
    }).catch(function () { setStatus("Could not reach the Radar service.", true); });
  }

  function probe() {
    return fetchJson("/health", { method: "GET" }, 1500).then(function (r) { return r.ok || r.status === 401; }).catch(function () { return false; });
  }

  function start() {
    probe().then(function (online) {
      if (online || isLocalPage || forceShow) {
        mount();
        if (online) refresh(); else setStatus("Opportunity Radar service is offline.", true);
      }
      if (!timer) timer = setInterval(function () {
        if (document.hidden) return;
        probe().then(function (on) {
          if (on && !mounted) { mount(); }
          if (on && mounted) refresh();
        });
      }, POLL_MS);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
