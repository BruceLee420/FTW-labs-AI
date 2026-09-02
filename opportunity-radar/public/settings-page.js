/**
 * Settings page. Shows the safe config summary (no paths, no secrets), AI
 * health, and lets the user store overrides (PATCH /settings), import/export
 * data, purge with a typed confirmation, and keep the API token in browser
 * storage. Everything talks only to the local API.
 */
(function () {
  "use strict";
  var R = window.Radar, el = R.el;
  var $ = function (id) { return document.getElementById(id); };
  var settings = null;

  function fail(statusEl, e) { statusEl.textContent = R.errorText(e); R.toast(R.errorText(e), "bad"); }
  function countsText(obj) { return Object.keys(obj || {}).map(function (k) { return k + " " + obj[k]; }).join(", ") || "nothing"; }

  function loadHealth() {
    return R.api("/health").then(function (h) {
      $("health-line").textContent = "Service v" + (h.version || "?") + " · database " + (h.db && h.db.ok ? "OK" : "error") + " · " + R.fmtDateTime(h.time);
      var r = h.resumes || {}, box = R.clear($("resume-status"));
      box.appendChild(el("div", { class: "row", style: "margin-bottom:8px" }, [
        el("span", { class: "badge " + (r.dirExists ? "ok" : "bad") }, r.dirExists ? "Folder reachable" : "Folder not found"),
        el("span", { class: "badge" }, r.dirConfigured ? "Environment variable set" : "Default folder"),
      ]));
      box.appendChild(R.kv([["Indexed profiles", String(r.indexedCount || 0)], ["Active profiles", String(r.activeCount || 0)]]));
    }).catch(function (e) { $("health-line").textContent = R.errorText(e); });
  }
  function loadSettings() {
    return R.api("/settings").then(function (s) {
      settings = s;
      var c = s.config || {}, ov = s.overrides || {}, ai = s.ai || {};
      R.clear($("ai-config")).appendChild(R.kv([
        ["Provider", String(c.aiProvider || "—") + (ov.aiProvider ? " (override: " + ov.aiProvider + ")" : "")],
        ["Model", String(c.ollamaModel || "—") + (ov.ollamaModel ? " (override: " + ov.ollamaModel + ")" : "")],
        ["Base URL", c.ollamaBaseUrl], ["Timeout", c.aiTimeoutSeconds ? c.aiTimeoutSeconds + " s" : null],
      ]));
      renderAi(ai);
      $("ai-provider").value = ov.aiProvider || "";
      $("ai-model").value = ov.ollamaModel || "";
      var dl = R.clear($("model-list"));
      (ai.availableModels || []).forEach(function (m) { dl.appendChild(el("option", { value: m })); });
      var hasOverride = typeof ov.followUpDays === "number";
      $("followup-days").value = hasOverride ? ov.followUpDays : (typeof c.followUpDays === "number" ? c.followUpDays : 7);
      $("followup-default").textContent = "Environment default OPPORTUNITY_RADAR_FOLLOW_UP_DAYS = " + c.followUpDays + (hasOverride ? "; override of " + ov.followUpDays + " days in effect." : ".");
      $("token-required").textContent = c.authRequired ? "This service requires a token." : "This service does not currently require a token.";
    }).catch(function (e) { $("ai-config").textContent = R.errorText(e); });
  }
  function renderAi(ai) {
    var tone = ai.reachable ? (ai.modelAvailable ? "ok" : "warn") : "warn";
    var text = ai.reachable ? (ai.modelAvailable ? "AI reachable — " + (ai.model || "model ready") : "Reachable, but " + (ai.model || "the configured model") + " is not pulled") : "AI offline — rules only";
    R.clear($("ai-status")).appendChild(el("div", { class: "card flat" }, [
      el("div", { class: "row" }, [el("span", { class: "badge " + tone }, text), el("span", { class: "small faint" }, "checked " + R.relTime(ai.checkedAt))]),
      el("p", { class: "small", style: "margin:8px 0 0" }, ai.message || ""),
      (ai.availableModels || []).length ? el("div", { style: "margin-top:8px" }, [el("span", { class: "small faint" }, "Available models: "), R.tags(ai.availableModels)]) : null,
    ]));
  }
  function loadSources() {
    return R.api("/sources").then(function (res) {
      var box = R.clear($("adapters")), c = (settings && settings.config) || {};
      box.appendChild(R.kv([["Env: Greenhouse boards", (c.greenhouseBoards || []).length ? c.greenhouseBoards : "none configured"], ["Env: RSS feeds", (c.rssFeeds || []).length ? c.rssFeeds : "none configured"],
        ["Env: extra denylist entries", String(c.urlDenylistCount || 0)]]));
      (res.adapters || []).forEach(function (a) {
        box.appendChild(el("div", { class: "card flat", style: "margin-top:10px" }, [
          el("div", { class: "row between" }, [el("strong", null, a.displayName), el("span", { class: "badge mono" }, a.id)]),
          el("p", { class: "small muted", style: "margin:6px 0" }, a.policyNote),
          R.kv([["Target", a.targetHint], ["Suggested targets", a.suggestedTargets]]),
        ]));
      });
      if (!(res.adapters || []).length) box.appendChild(el("p", { class: "faint small" }, "No adapters registered."));
      box.appendChild(el("p", { class: "small", style: "margin:10px 0 0" }, el("a", { href: "/opportunity-radar/" }, "Run a sync from the Radar page → Sources")));
    }).catch(function (e) { $("adapters").textContent = R.errorText(e); });
  }

  function onAiSave(e) {
    e.preventDefault();
    var st = $("ai-form-status"), body = {}, p = $("ai-provider").value, m = $("ai-model").value.trim();
    if (p) body.aiProvider = p;
    if (m) body.ollamaModel = m;
    if (!Object.keys(body).length) { st.textContent = "Nothing to save — choose a provider or enter a model. Clearing an override is not supported by the API; set the environment variable you want and restart instead."; return; }
    R.busy($("ai-save"), R.api("/settings", { method: "PATCH", body: body })).then(function () {
      st.textContent = "Saved. If a provider or model change does not take effect, restart the service.";
      R.toast("AI overrides saved.");
      loadSettings();
    }).catch(function (err) { fail(st, err); });
  }
  function onFollowUpSave(e) {
    e.preventDefault();
    var st = $("followup-status"), n = R.numberOrUndefined($("followup-days").value);
    if (n === undefined || n < 0 || n > 365 || n !== Math.floor(n)) { st.textContent = "Enter a whole number of days between 0 and 365."; return; }
    R.busy($("followup-save"), R.api("/settings", { method: "PATCH", body: { followUpDays: n } })).then(function () {
      st.textContent = "Saved — new \"applied\" records schedule a follow-up " + n + " day" + (n === 1 ? "" : "s") + " later.";
      R.toast("Follow-up interval saved.");
      loadSettings();
    }).catch(function (err) { fail(st, err); });
  }
  function onImportJson(e) {
    e.preventDefault();
    var st = $("import-json-status"), file = $("import-json-file").files[0];
    if (!file) { st.textContent = "Choose a file first."; return; }
    st.textContent = "Reading…";
    R.busy($("import-json-submit"), R.fileText(file).then(function (txt) {
      var parsed;
      try { parsed = JSON.parse(txt); } catch (err) { throw new Error("That file is not valid JSON."); }
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.opportunities)) throw new Error("Expected an Opportunity Radar export: version 1 with an opportunities array.");
      var body = { export: { version: 1, opportunities: parsed.opportunities, applications: parsed.applications || [], drafts: parsed.drafts || [], followUps: parsed.followUps || [] } };
      return R.api("/data/import", { body: body });
    })).then(function (res) {
      st.textContent = "Imported: " + countsText(res.imported) + ".";
      R.toast("Import complete.");
      $("import-json-form").reset();
      loadHealth();
    }).catch(function (err) { fail(st, err); });
  }
  function onImportCsv(e) {
    e.preventDefault();
    var st = $("import-csv-status"), file = $("import-csv-file").files[0];
    if (!file) { st.textContent = "Choose a file first."; return; }
    st.textContent = "Reading…";
    R.busy($("import-csv-submit"), R.fileText(file).then(function (csv) {
      if (!csv.trim()) throw new Error("The file is empty.");
      return R.api("/opportunities/import-csv", { body: { csv: csv, sourceName: $("import-csv-source").value.trim() || "csv-import", evaluate: $("import-csv-evaluate").checked } });
    })).then(function (res) {
      st.textContent = "Created " + (res.created || 0) + ", duplicates " + (res.duplicates || 0) + ".";
      R.toast("CSV import complete.");
      $("import-csv-form").reset();
      $("import-csv-source").value = "csv-import";
      loadHealth();
    }).catch(function (err) { fail(st, err); });
  }
  function onPurge(e) {
    e.preventDefault();
    var st = $("purge-status"), scope = $("purge-scope").value, scopeText = $("purge-scope").selectedOptions[0].textContent;
    if ($("purge-confirm").value !== "DELETE EVERYTHING") { st.textContent = "Type DELETE EVERYTHING exactly."; return; }
    R.confirm("Permanently delete " + scopeText.toLowerCase() + " from the local database? This cannot be undone; export JSON first if you might want it back.", { danger: true, confirmLabel: "Delete now", title: "Delete data" }).then(function (ok) {
      if (!ok) return;
      R.busy($("purge-submit"), R.api("/data/purge", { body: { confirm: "DELETE EVERYTHING", scope: scope } })).then(function (res) {
        st.textContent = "Deleted: " + countsText(res.deleted) + ".";
        $("purge-confirm").value = "";
        $("purge-submit").disabled = true;
        R.toast("Data deleted.");
        loadHealth();
      }).catch(function (err) { fail(st, err); });
    });
  }
  function onTokenSave(e) {
    e.preventDefault();
    var v = $("token-input").value.trim(), st = $("token-status");
    if (!v) { st.textContent = "Enter a token, or use Clear to remove the saved one."; return; }
    R.setToken(v, true);
    $("token-input").value = "";
    st.textContent = "Token saved for this session and for the dashboard widget (localStorage).";
    R.toast("Token saved.");
    loadHealth(); loadSettings().then(loadSources);
  }
  function onTokenClear() {
    R.setToken("", true);
    $("token-input").value = "";
    $("token-status").textContent = "Token cleared from this browser.";
  }
  function init() {
    R.nav("settings");
    $("ai-form").addEventListener("submit", onAiSave);
    $("followup-form").addEventListener("submit", onFollowUpSave);
    $("import-json-form").addEventListener("submit", onImportJson);
    $("import-csv-form").addEventListener("submit", onImportCsv);
    $("purge-form").addEventListener("submit", onPurge);
    $("purge-confirm").addEventListener("input", function () { $("purge-submit").disabled = $("purge-confirm").value !== "DELETE EVERYTHING"; });
    $("token-form").addEventListener("submit", onTokenSave);
    $("token-clear").addEventListener("click", onTokenClear);
    $("token-status").textContent = R.getToken() ? "A token is currently saved in this browser." : "No token saved in this browser.";
    $("link-export-json").addEventListener("click", function (e) {
      if (!R.getToken()) return; // the plain link works when no token is configured
      e.preventDefault();
      R.download(e.currentTarget.href, "opportunity-radar-export.json").catch(function (err) { R.toast(R.errorText(err), "bad"); });
    });
    loadHealth();
    loadSettings().then(loadSources);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
