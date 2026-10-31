// Agents page entry: fleet hero + sortable agent table + expandable profiles.
//
// ## Connections
// - IMPORTS FROM: data.js ($, money, collecting, esc, tsH, buildRows,
//   winSlice, keyDelta, keyRate, computeRate, getRateWin)
// - EXPORTS: nothing (side effects on import)
// - CALLED BY: agents.html <script type="module" src="js/agents-app.js">
// - CALLS: fetch("/data"); data helpers for per-agent windowed spend and burn
//   rate (same history deltas the dashboard uses — one source of truth)
// - CONTRACT: one row per connected agent (snapshot.catalog covers even
//   zero-spend agents); columns sortable (click, flip). Clicking a row
//   expands an inline profile beneath it (one at a time): header strip
//   (status, records, lifetime, last activity), SOUL role, cron tasks,
//   models with per-agent lifetime cost, top sessions (user-named), and a
//   db-path footer. Active = last activity within 30 min. All text escaped;
//   missing data degrades to "—"/"no cron tasks". Timeframe columns follow
//   the ladder (1h 6h 24h 7d 14d 30d); burn rate follows #rate-win.

import { $, money, collecting, esc, tsH, buildRows, winSlice, keyDelta, computeRate, getRateWin } from "./data.js";

const ACTIVE_S = 30 * 60;

let last = null;       // {s, rows, catalog, sessions, names}
let sort = {k: "life", dir: -1};
let open = null;       // expanded agent label (or null)
let pendingDel = null; // {label, job_id, name} awaiting modal confirmation
let pendingTgl = null;  // {label, job_id, enabled} optimistic toggle in flight
let editingFile = null; // {label, rel} file open in the editor modal
let fileEditor = null;  // CodeMirror instance (or <textarea> fallback)
function editorSet(v){
  const host = $("file-modal-ed");
  if(window.CodeMirror && !fileEditor){
    fileEditor = CodeMirror(host, {value: v || "", mode: "markdown", lineNumbers: true,
      lineWrapping: true, keyMap: "vim", tabSize: 2, indentUnit: 2});
  } else if(fileEditor && fileEditor.setValue){ fileEditor.setValue(v || ""); fileEditor.clearHistory(); }
  else { // offline fallback: plain textarea
    host.innerHTML = ""; const ta = document.createElement("textarea");
    ta.className = "file-editor"; ta.style.cssText = "width:100%;min-height:320px;max-height:60vh;background:#10131a;color:#c4cad6;border:1px solid #2c313a;border-radius:8px;padding:10px 12px;font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace;resize:vertical;box-sizing:border-box;"; ta.spellcheck = false;
    ta.value = v || ""; host.appendChild(ta);
  }
}
function editorGet(){
  if(fileEditor && fileEditor.getValue) return fileEditor.getValue();
  return ($("file-modal-ed").querySelector("textarea") || {}).value || "";
}

const shortId = x => x && x.length > 26 ? x.slice(0, 12) + "…" + x.slice(-8) : (x || "—");
const trunc = (s, n) => { const t = (s||"").trim(); return t.length > n ? t.slice(0, n-1) + "…" : t; };

// full spend-window ladder: [minutes, key, label]
const WINS = [[5,"m5","5m"],[15,"m15","15m"],[30,"m30","30m"],[60,"h1","1h"],
  [180,"h3","3h"],[360,"h6","6h"],[720,"h12","12h"],[1440,"h24","24h"],
  [4320,"d3","3d"],[10080,"d7","7d"],[20160,"d14","14d"],[43200,"d30","30d"]];

// cheap but capable coding models (curated from OpenRouter programming
// rankings: v4-flash = absolute cheapest; qwen3-coder line; gemini flash)
const CURATED_MODELS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "qwen/qwen3-coder",
  "qwen/qwen3-coder-flash",
  "qwen/qwen3-coder-30b-a3b-instruct",
  "google/gemini-3.5-flash",
  "stepfun/step-3.7-flash",
  "mistralai/codestral-2508",
];

function oneLineRole(soul){
  if(!soul) return "stock identity";
  const first = soul.split(/\n{2,}|\.\s|\n/)[0].trim();
  return first.length > 78 ? first.slice(0, 75) + "…" : first;
}

function buildRows_(s){
  const by = s.by_agent || {};
  return last.catalog.map(c => {
    const life = by[c.label] || 0;
    const win = {};
    for(const [m, k] of WINS) win[k] = keyDelta(winSlice(last.rows, m), "by_agent", c.label);
    const active = c.last && s.ts - c.last <= ACTIVE_S;
    return {label: c.label, role: oneLineRole(c.soul), life, win,
      m15: win.m15, h1: win.h1, h3: win.h3, last: c.last || 0, active,
      crons: c.crons||[], latest: c.latest};
  });
}

function hero(s){
  const cats = last.catalog;
  $("ag-count").textContent = cats.length;
  $("ag-active").textContent = cats.filter(c => c.last && s.ts - c.last <= ACTIVE_S).length;
  $("ag-lifetime").textContent = money(s.ledger_total_cost);
  const rate = computeRate(s, last.rows, getRateWin());
  $("ag-rate").innerHTML = rate ? "$" + rate.ratePerH.toFixed(2) + "/h" : collecting();
  $("ag-crons").textContent = cats.filter(c => (c.crons||[]).some(j => j.enabled)).length;
}

function cronsCell(crons){
  if(!crons.length) return '<span class="muted">—</span>';
  const on = crons.filter(j => j.enabled).length;
  return `${crons.length} <span class="badge ${on ? "on" : "off"}">${on ? on + " on" : "off"}</span>`;
}

// ---------- expanded profile ----------

function srcAgent(label){ return last.catalog.find(c => c.label === label); }

function agentModelCosts(label){
  const m = {};
  for(const x of last.sessions || []){
    if(x.agent !== label) continue;
    for(const r of (x.models||[])) m[r.model] = (m[r.model]||0) + r.cost;
  }
  return Object.entries(m).sort((a,b) => b[1]-a[1]);
}

function topSessions(label){
  return (last.sessions||[]).filter(x => x.agent === label)
    .sort((a,b) => b.cost - a.cost).slice(0, 5);
}

function profileHtml(r){
  const a = srcAgent(r.label) || {};

  // SOUL — role
  const about = a.soul
    ? `<div class="prof-role">${esc(a.soul)}</div>`
    : '<div class="prof-role muted">no custom ## Role — see "Definition" below for how this agent is wired</div>';

  // Definition — the files that determine what this agent IS and does
  const df    = a.def_files || [];
  const skills = a.skills || [];
  const cfg   = a.config || {};
  const FILE_EDIT = {"SOUL.md":1, "memories/MEMORY.md":1, "memories/USER.md":1};
  const defItems = df.map(f => `<div class="def-item">
        <div class="def-top"><span class="def-name">${esc(f.file)}</span><span class="muted"> · ${(f.bytes/1024).toFixed(1)} KB</span>${FILE_EDIT[f.file] ? `<button class="def-edit" data-file="${esc(f.file)}" title="edit ${esc(f.file)}">✎</button>` : ""}</div>
        <div class="def-ex muted">${esc(f.excerpt || "—")}</div>
      </div>`).join("");
  // known models = every model any agent has used (from catalog) + current pick
  const knownModels = [...new Set((last.s.catalog || []).flatMap(c => (c.models || [])))].sort();
  const curModel = cfg.model || (knownModels[0] || "");
  const fleetOpts = [...new Set([curModel, ...knownModels].filter(Boolean))]
    .map(m => `<option value="${esc(m)}" ${m === curModel ? "selected" : ""}>${esc(m)}</option>`).join("");
  const pickOpts = [...new Set(CURATED_MODELS.filter(m => m !== curModel && !knownModels.includes(m)))]
    .map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  const modelOpts = fleetOpts + (pickOpts ? `<optgroup label="cheap picks for coding">${pickOpts}</optgroup>` : "");
  const defHtml = (defItems || '<div class="muted">no definition files</div>') +
    `<div class="def-item"><div class="def-top"><span class="def-name">skills/</span><span class="muted"> · ${skills.length} skills</span><button class="skills-explore" title="browse ${skills.length} skills">👁</button></div>
       <div class="def-ex muted">${esc(skills.slice(0, 10).map(s => s.name).join(", "))}${skills.length > 10 ? "…" : ""}</div></div>`;
  // model bar — very top of the card
  const modelBar = `<img class="agent-avatar lg" src="/avatar?label=${encodeURIComponent(r.label)}" alt="" loading="lazy"><span class="prof-model"><span class="def-name">model</span>
      <select class="model-sel" data-label="${esc(r.label)}" title="change the model this agent uses (patches config.yaml model block)">${modelOpts}</select>
      ${cfg.provider ? `<span class="muted">· ${esc(cfg.provider)}</span>` : ""}</span>`;

  // Recent spend — full window ladder (5m … 30d) per agent
  const winChips = WINS.map(([m, k, l]) => {
      const v = r.win ? r.win[k] : null;
      return `<span class="win-chip"><b>${l}</b> ${v == null ? collecting() : money(v)}</span>`;
    }).join("");
  const recents = `<div class="win-strip">${winChips}</div>`;

  // cron tasks
  const crons = r.crons || [];
  const CUR = window.CRON_CADENCES || [[1,"1m"],[5,"5m"],[15,"15m"],[30,"30m"],[60,"1h"],[360,"6h"],[720,"12h"],[1440,"24h"]];
  const cadenceOf = j => j.minutes != null ? j.minutes : null;
  const cronRows = crons.length
    ? `<div class="table-wrap"><table class="mini"><thead><tr><th>task</th><th class="num">schedule</th><th class="num">set cadence</th><th class="num">enabled</th><th class="num">state</th><th>prompt</th><th class="num"></th></tr></thead><tbody>` +
      crons.map(j => {
        const cur = cadenceOf(j);
        const opts = CUR.map(([m, l]) => `<option value="${m}" ${m === cur ? "selected" : ""}>${l}</option>`).join("");
        const schedTxt = j.schedule || "—";
        const enabled = j.enabled;
        return `<tr>
          <td>${esc(j.name)}</td>
          <td class="num">${esc(schedTxt)}</td>
          <td class="num"><select class="cron-min" data-job="${esc(j.id || j.name)}">${opts}</select></td>
          <td class="num"><button class="cron-tgl ${enabled ? "on" : "off"}" data-job="${esc(j.id || j.name)}" data-on="${enabled ? "1" : "0"}" title="enable/disable this cron job">${enabled ? "on" : "off"}</button></td>
          <td class="num muted">${esc(j.state || "—")}</td>
          <td class="muted" title="${esc(j.prompt || "")}">${esc(trunc(j.prompt, 60) || "—")}</td>
          <td class="num"><button class="cron-del" data-job="${esc(j.id || j.name)}" title="delete this cron job">🗑</button></td>
        </tr>`;
      }).join("") + "</tbody></table></div>"
    : '<div class="muted">no cron tasks</div>';

  // top sessions (user-named)
  const names = last.names || {};
  const withName = x => names[x.session]
    ? `${esc(names[x.session])} <span class="muted">· ${esc(shortId(x.session))}</span>`
    : esc(shortId(x.session));
  const sess = topSessions(r.label);
  const sessHtml = sess.length
    ? `<div class="table-wrap"><table class="mini"><thead><tr><th>session</th><th class="num">cost</th><th class="num">last seen</th></tr></thead><tbody>` +
      sess.map(x => `<tr><td>${withName(x)}</td><td class="num">${money(x.cost)}</td><td class="num muted">${x.last ? tsH(x.last) : "—"}</td></tr>`).join("") +
      `<tr class="total-row"><td>TOTAL — top ${sess.length} sessions</td><td class="num">${money(sess.reduce((acc,x)=>acc+x.cost,0))}</td><td></td></tr></tbody></table></div>`
    : '<div class="muted">no sessions yet</div>';

  // models used, with per-agent lifetime cost
  const mods = agentModelCosts(r.label);
  const modelsHtml = mods.length
    ? mods.map(([mm, v]) => `<span class="chip" title="${esc(mm)}">${esc(mm.split("/").pop())} · ${money(v)}</span>`).join("")
    : '<span class="muted">—</span>';

  return `<div class="profile">
      <div class="prof-model-bar">${modelBar}</div>
      <div class="prof-grid">
        <section class="prof-sec prof-wide"><div class="sec-head"><h4>SOUL — role</h4><button class="def-edit" data-file="SOUL.md" title="edit SOUL.md">✎</button></div>${about}</section>
        <section class="prof-sec prof-wide"><h4>Recent spend</h4>${recents}</section>
        <section class="prof-sec prof-wide"><h4>Cron tasks (${crons.length})</h4>${cronRows}</section>
        <section class="prof-sec"><h4>Models used</h4><div>${modelsHtml}</div></section>
        <section class="prof-sec"><h4>Top sessions by cost</h4>${sessHtml}</section>
        <section class="prof-sec prof-wide"><h4>Definition — what wires this agent</h4><div class="def-grid">${defHtml}</div></section>
      </div>
      <div class="prof-foot muted">state.db: <span style="word-break:break-all">${esc(a.db || "—")}</span></div>
    </div>`;
}

// ---------- table ----------

function render(){
  const s = last.s;
  const rows = buildRows_(s);
  rows.sort(sort.k === "label" || sort.k === "role" || sort.k === "latest"
    ? (a,b) => sort.dir * String(a[sort.k] || "").localeCompare(String(b[sort.k] || ""))
    : (a,b) => sort.dir * ((a[sort.k] ?? -1) - (b[sort.k] ?? -1)));
  document.querySelectorAll("#agents-table th.sortable").forEach(th => {
    th.classList.toggle("sorted", th.dataset.k === sort.k);
    th.classList.toggle("desc", th.dataset.k === sort.k && sort.dir < 0);
  });
  const tb = $("agents-tbody");
  tb.innerHTML = rows.map(r => {
    const pct = s.ledger_total_cost ? (100*r.life/s.ledger_total_cost).toFixed(0) : "0";
    return `<tr class="agent-row ${r.label === open ? "open" : ""}" data-agent="${esc(r.label)}">
      <td><span class="chev">${r.label === open ? "▾" : "▸"}</span><img class="agent-avatar" src="/avatar?label=${encodeURIComponent(r.label)}" alt="" loading="lazy"><span class="dot ${r.active ? "on" : "off"}" title="${r.active ? "active in last 30m" : ""}"></span><span class="ag-name">${esc(r.label)}</span>${r.active ? ' <span class="badge on">now</span>' : ""}</td>
      <td><span title="${esc(r.soul || "")}">${esc(r.role)}</span></td>
      <td class="num muted">${r.last ? tsH(r.last) : "—"}</td>
      <td class="num">${money(r.life)} <span class="muted">(${pct}%)</span></td>
      <td class="num">${r.m15 == null ? collecting() : money(r.m15)}</td>
      <td class="num">${r.h1 == null ? collecting() : money(r.h1)}</td>
      <td class="num">${r.h3 == null ? collecting() : money(r.h3)}</td>
      <td class="num">${cronsCell(r.crons)}</td>
    </tr>` + (r.label === open ? `<tr class="agent-detail-row"><td colspan="8">${profileHtml(r)}</td></tr>` : "");
  }).join("") || '<tr><td colspan="8" class="muted">no agents connected — add entries to agents.json or a scan_dir</td></tr>';
}

function bind(){
  // hide the avatar img when no avatar.png exists yet (no broken-image icon)
  $("agents-tbody").addEventListener("error", e => {
    if(e.target.classList && e.target.classList.contains("agent-avatar")) e.target.style.display = "none";
  }, true);
  // clicking an agent row toggles its inline profile (one at a time)
  $("agents-tbody").addEventListener("click", e => {
    const tr = e.target.closest("tr[data-agent]");
    if(!tr) return;
    const label = tr.dataset.agent;
    open = open === label ? null : label;
    render();
  });
  // cron actions inside the open profile
  $("agents-tbody").addEventListener("change", async e => {
    const sel = e.target.closest("select.cron-min");
    if(!sel || !open) return;
    await fetch("/cron/update", {method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({label: open, job_id: sel.dataset.job, minutes: sel.value})});
    load();
  });
  $("agents-tbody").addEventListener("click", e => {
    const tgl = e.target.closest("button.cron-tgl");
    if(tgl && open){
      const target = tgl.dataset.on === "1" ? 0 : 1;
      pendingTgl = {label: open, job_id: tgl.dataset.job, enabled: target};
      tgl.setAttribute("data-on", target);
      tgl.textContent = target ? "on" : "off";
      tgl.className = tgl.className.replace(/\b(?:on|off)\b/, target ? "on" : "off");
      fetch("/cron/enable", {method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(pendingTgl)}).then(() => load());
      return;
    }
    const btn = e.target.closest("button.cron-del");
    if(!btn || !open) return;
    pendingDel = {label: open, job_id: btn.dataset.job, name: btn.dataset.job};
    $("cron-modal-text").textContent = `"${btn.dataset.job}" will be removed from the agent's cron/jobs.json. This cannot be undone.`;
    $("cron-modal").hidden = false;
  });
  // cron delete modal wiring
  const closeModal = () => { $("cron-modal").hidden = true; pendingDel = null; };
  document.getElementById("cron-modal-cancel").addEventListener("click", closeModal);
  document.getElementById("cron-modal").addEventListener("click", e => { if(e.target.id === "cron-modal") closeModal(); });
  document.getElementById("cron-modal-ok").addEventListener("click", async () => {
    const p = pendingDel;
    closeModal();
    if(!p) return;
    await fetch("/cron/delete", {method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({label: p.label, job_id: p.job_id})});
    load();
  });
  // definition file editing
  $("agents-tbody").addEventListener("click", async e => {
    const ed = e.target.closest("button.def-edit");
    if(!ed || !open) return;
    editingFile = {label: open, rel: ed.dataset.file};
    $("file-modal-title").textContent = "Edit " + (ed.dataset.file.split("/").pop());
    $("file-modal-path").textContent = open + " · " + ed.dataset.file;
    $("file-modal").hidden = false;
    editorSet("loading…");
    const url = "/file?label=" + encodeURIComponent(open) + "&rel=" + encodeURIComponent(ed.dataset.file);
    try {
      const d = await (await fetch(url)).json();
      editorSet(d.ok ? d.content : "(could not read file)");
    } catch (err) { editorSet("(load error: " + err.message + ")"); }
  });
  document.getElementById("file-modal-cancel").addEventListener("click", () => {
    $("file-modal").hidden = true; editingFile = null;
  });
  document.getElementById("file-modal").addEventListener("click", e => { if(e.target.id === "file-modal") { $("file-modal").hidden = true; editingFile = null; } });
  document.getElementById("file-modal-ok").addEventListener("click", async () => {
    const f = editingFile;
    if(!f) return;
    await fetch("/file/save", {method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({label: f.label, rel: f.rel, content: editorGet()})});
    $("file-modal").hidden = true;
    editingFile = null;
    load();
  });
  // model switch
  $("agents-tbody").addEventListener("change", e => {
    const sel = e.target.closest("select.model-sel");
    if(!sel) return;
    fetch("/model", {method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({label: sel.dataset.label, model: sel.value})}).then(() => load());
  });
  // skills explorer
  const skillsRender = (sk, q) => {
    const t = q.trim().toLowerCase();
    $("skills-list").innerHTML = sk
      .filter(s => !t || s.name.toLowerCase().includes(t) || (s.desc||"").toLowerCase().includes(t))
      .map(s => `<li><b>${esc(s.name)}</b><span class="muted">${s.desc ? " — " + esc(s.desc) : ""}</span></li>`).join("")
      || '<li class="muted">no skills match</li>';
  };
  const skillsOpen = () => {
    const a = open ? srcAgent(open) : null;
    const sk = (a && a.skills) || [];
    $("skills-modal-title").textContent = "Skills — " + open;
    $("skills-modal-path").textContent = sk.length + " skills installed";
    $("skills-filter").value = "";
    skillsRender(sk, "");
    $("skills-modal").hidden = false;
  };
  $("agents-tbody").addEventListener("click", e => {
    if(e.target.closest("button.skills-explore") && open) skillsOpen();
  });
  document.getElementById("skills-modal-close").addEventListener("click", () => { $("skills-modal").hidden = true; });
  document.getElementById("skills-modal").addEventListener("click", e => { if(e.target.id === "skills-modal") $("skills-modal").hidden = true; });
  document.getElementById("skills-filter").addEventListener("input", e => {
    const a = open ? srcAgent(open) : null;
    skillsRender((a && a.skills) || [], e.target.value);
  });
  document.querySelectorAll("#agents-table th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if(sort.k === k) sort.dir *= -1;
      else sort = {k, dir: k === "label" || k === "role" ? 1 : -1};
      render();
    });
  });
}

async function load(){
  try{
    const d = await (await fetch("/data")).json();
    const s = d.snapshot;
    last = {s, rows: buildRows(d), catalog: s.catalog || [], sessions: s.sessions || [], names: d.names || {}};
    $("stamp").textContent = "updated " + new Date(s.ts*1000).toLocaleTimeString() + " · " + s.records + " records";
    hero(s);
    render();
  }catch(e){ $("stamp").textContent = "load error: " + e.message; }
}

bind();
document.getElementById("rate-win").addEventListener("change", () => { if(last){ hero(last.s); render(); } });
load();
setInterval(load, 60e3);
