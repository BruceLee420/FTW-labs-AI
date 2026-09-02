/**
 * Résumé Library page. Indexes the local résumé folder and shows metadata only
 * — filename (relative), label, tags, extraction status/quality, counts. The
 * page never requests extracted text and never learns the folder path; row
 * edits go through PATCH /resumes/:id and removal through DELETE /resumes/:id
 * (which leaves the file untouched).
 */
(function () {
  "use strict";
  var R = window.Radar, el = R.el;
  var $ = function (id) { return document.getElementById(id); };
  var items = [];

  function fail(e) { R.toast(R.errorText(e), "bad"); }
  function h4(text) { return el("h4", { class: "small", style: "margin-top:8px" }, text); }
  function fmtBytes(n) {
    if (typeof n !== "number") return "";
    return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  }
  function patch(id, body) { return R.api("/resumes/" + encodeURIComponent(id), { method: "PATCH", body: body }); }

  function load() {
    return R.api("/resumes").then(function (res) {
      items = res.items || [];
      renderDir(res);
      renderRows();
      renderProfiles();
    }).catch(function (e) { $("dir-status").textContent = R.errorText(e); renderRows(); fail(e); });
  }
  function renderDir(res) {
    var active = items.filter(function (r) { return r.isActive; }).length;
    R.append(R.clear($("dir-status")), [
      el("span", { class: "badge " + (res.dirExists ? "ok" : "bad"), style: "margin-right:8px" }, res.dirExists ? "Folder reachable" : "Folder not found"),
      el("span", { class: "badge", style: "margin-right:8px" }, res.dirConfigured ? "OPPORTUNITY_RADAR_RESUMES_DIR set" : "Default folder"),
      items.length + " profile" + (items.length === 1 ? "" : "s") + " indexed · " + active + " active. " +
        (res.dirExists ? "" : "Create the folder or point OPPORTUNITY_RADAR_RESUMES_DIR at an existing one (see Settings)."),
    ]);
  }
  function renderRows() {
    var tb = R.clear($("rows"));
    if (!items.length) {
      tb.appendChild(el("tr", null, el("td", { colspan: 11, class: "empty" }, "No résumés indexed yet. Put PDF, DOCX, TXT or Markdown files in your résumé folder and click “Index folder”.")));
      return;
    }
    items.forEach(function (r) { tb.appendChild(row(r)); });
  }
  function row(r) {
    var label = R.input({ value: r.label, maxlength: 300, "aria-label": "Label for " + r.filename });
    var roles = R.input({ value: (r.targetRoles || []).join(", "), placeholder: "comma-separated", "aria-label": "Target roles for " + r.filename });
    var save = el("button", { class: "btn btn-sm", type: "button", onclick: function () {
      var body = { label: label.value.trim() || r.label, targetRoles: R.parseList(roles.value) };
      R.busy(save, patch(r.id, body)).then(function () { R.toast("Saved."); load(); }).catch(fail);
    } }, "Save");
    var active = el("input", { type: "checkbox", checked: r.isActive, "aria-label": "Active: " + r.filename, onchange: function () {
      var next = active.checked;
      R.busy(active, patch(r.id, { isActive: next })).then(function () { R.toast(next ? "Activated." : "Deactivated — excluded from matching and drafting."); load(); })
        .catch(function (e) { active.checked = !next; fail(e); });
    } });
    var del = el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: function () {
      R.confirm("Remove “" + r.label + "” from the index? The file in your folder is not touched.", { danger: true, confirmLabel: "Remove", title: "Remove from index" }).then(function (ok) {
        if (!ok) return;
        R.busy(del, R.api("/resumes/" + encodeURIComponent(r.id), { method: "DELETE" })).then(function () { R.toast("Removed from the index."); load(); }).catch(fail);
      });
    } }, "Delete");
    return el("tr", null, [
      el("td", null, [el("span", { class: "mono small" }, r.filename), el("div", { class: "small faint" }, fmtBytes(r.fileSize))]),
      el("td", null, label),
      el("td", null, el("span", { class: "badge" }, r.format)),
      el("td", null, [roles, (r.targetRoles || []).length ? el("div", { style: "margin-top:4px" }, R.tags(r.targetRoles)) : null]),
      el("td", null, String((r.skills || []).length)),
      el("td", null, R.badgeFor(r.extractionStatus, "extractionStatus")),
      el("td", null, R.scoreBar("Extraction quality", r.extractionQuality)),
      el("td", null, String(r.extractedCharacters || 0)),
      el("td", null, el("time", { datetime: r.lastIndexedAt, title: R.fmtDateTime(r.lastIndexedAt) }, R.relTime(r.lastIndexedAt))),
      el("td", null, active),
      el("td", null, el("div", { class: "row", style: "flex-wrap:nowrap" }, [save, del])),
    ]);
  }
  function renderProfiles() {
    var box = R.clear($("profile-list"));
    if (!items.length) { box.appendChild(el("p", { class: "faint small", style: "margin:0" }, "Nothing indexed yet.")); return; }
    items.forEach(function (r) {
      box.appendChild(el("details", { class: "card" }, [
        el("summary", null, r.label + " — " + r.filename + (r.isActive ? "" : " (inactive)")),
        el("div", { class: "stack", style: "margin-top:10px" }, [
          el("div", { class: "row" }, [R.badgeFor(r.extractionStatus, "extractionStatus"), R.scoreBar("Extraction quality", r.extractionQuality, false, true),
            el("span", { class: "small faint" }, (r.extractedCharacters || 0) + " characters extracted · indexed " + R.fmtDateTime(r.lastIndexedAt))]),
          h4("Skills"), R.tags(r.skills),
          h4("Industries"), R.tags(r.industries),
          h4("Experience"), el("p", { style: "margin:0" }, r.experienceSummary || "—"),
          h4("Education"), el("p", { style: "margin:0" }, r.educationSummary || "—"),
          h4("Verified facts"),
          (r.verifiedFacts || []).length ? el("ul", { class: "plain" }, r.verifiedFacts.map(function (f) {
            return el("li", null, [el("span", { class: "badge", style: "margin-right:6px" }, f.kind), f.text]);
          })) : el("p", { class: "faint small", style: "margin:0" }, "None extracted."),
          h4("Extraction notes"), R.list(r.extractionNotes, "No notes."),
          el("p", { class: "small faint", style: "margin:0" }, "Metadata only. Extracted text stays in the local database and is never displayed; it is shared only with your local Ollama, for one selected profile, when you generate a draft."),
        ]),
      ]));
    });
  }
  function onIndex(e) {
    e.preventDefault();
    var out = $("index-result");
    out.hidden = false;
    out.className = "notice";
    out.textContent = "Indexing… reading the files in your résumé folder.";
    R.busy($("index-submit"), R.api("/resumes/index", { body: { force: $("index-force").checked } })).then(function (res) {
      R.clear(out);
      out.className = "notice " + (res.failed || res.needsOcr ? "hot" : "teal");
      R.append(out, [el("strong", null, "Index complete. "), "Indexed " + res.indexed + " · skipped (unchanged) " + res.skipped + " · failed " + res.failed + " · needs OCR " + res.needsOcr + " · removed " + res.removed + "."]);
      if (res.needsOcr) out.appendChild(el("div", { class: "small", style: "margin-top:4px" }, "NEEDS_OCR files are scans or image-only PDFs. Export a text-based PDF, save as DOCX/Markdown, or run OCR (for example ocrmypdf) and re-index."));
      load();
    }).catch(function (err) { out.className = "notice hot"; out.textContent = R.errorText(err); fail(err); });
  }
  function init() {
    R.nav("resumes");
    $("index-form").addEventListener("submit", onIndex);
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
