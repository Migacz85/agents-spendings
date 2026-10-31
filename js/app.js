// Application entry: fetch loop, timeframe state, panel drag, render wiring.
//
// ## Connections
// - IMPORTS FROM: data.js ($, buildRows), charts.js (cumulativeChart, barH),
//   tables.js (renderCards, renderAgentTable,
//   renderModelsDetail, initTableSort), projection.js (renderProjection,
//   initCapUI), sessions.js (renderSessionExplorer, initSessionUI)
// - EXPORTS: nothing (side effects on import)
// - CALLED BY: index.html <script type="module" src="js/app.js">
// - CALLS: fetch("/data") every 60s and on pill click; delegates each UI
//   region to its module. Owns the shared `tf` timeframe state (minutes),
//   the fetched-payload cache for dependency-free re-renders (cap dropdown,
//   session picks, sort headers — no refetch), and panel ordering/persistence
//   (localStorage "spendPanelOrder").
// - CONTRACT: single place where /data is fetched and rendered; region modules
//   are pure renders taking the data. apply(d) renders every region from one
//   payload — call it with the cached payload for local UI changes.

import { $, buildRows, calInfo } from "./data.js";
import { cumulativeChart, balanceChart, inOutChart } from "./charts.js";
import { renderCards, renderAgentTable, renderModelsDetail, initTableSort } from "./tables.js";
import { renderProjection, initCapUI } from "./projection.js";
import { renderSessionExplorer, initSessionUI } from "./sessions.js";

let lastData = null;
let chartWin = 480;  // THE timeframe (minutes) — shared by every widget; 0 = all, default 8h
let calOn = true;    // calibrate ledger-based per-agent/model figures to paid spend
try { calOn = localStorage.getItem("spendCal") !== "0"; } catch(_) {}
let agentsAxis = "balance";   // agents chart left axis: "balance" (down) | "spent" (up from $0)
try { agentsAxis = localStorage.getItem("spendAxis") === "spent" ? "spent" : "balance"; } catch(_) {}
let tokLife = false;          // models table token/call columns: false = shared timeframe, true = lifetime
try { tokLife = localStorage.getItem("tokLife") === "1"; } catch(_) {}

function apply(d){
  lastData = d;
  const s = d.snapshot;
  const bi = d.build || {};
  $("stamp").textContent = "updated " + new Date(s.ts*1000).toLocaleTimeString() + " · " + s.records + " records"
    + (bi.env ? " · " + bi.env + " " + bi.build : "");
  $("c-balance").textContent = s.balance && s.balance.balance != null ? "$" + s.balance.balance.toFixed(2) : "—";
  $("c-used").textContent = s.balance && s.balance.total_usage != null ? "$" + s.balance.total_usage.toFixed(2) : "";

  const rows = buildRows(d);
  // calibration: reconcile ledger ESTIMATES with what was actually paid.
  // The factor is displayed (never hidden) and can be switched off.
  const ci = calInfo(rows);
  const f = (calOn && ci) ? ci.factor : 1;
  const calNote = $("cal-note");
  if(calNote) calNote.textContent = ci
    ? (calOn
        ? "estimates ×" + ci.factor.toFixed(2) + " → paid  (est $" + ci.est.toFixed(2) + " vs paid $" + ci.paid.toFixed(2) + ")"
        : "raw estimates ×1.00 — calibration OFF  (paid $" + ci.paid.toFixed(2) + " vs est $" + ci.est.toFixed(2) + ")")
    : "";

  renderCards(s, rows);
  renderAgentTable(s, rows, f);
  renderProjection(s, rows);
  cumulativeChart("chart-agents", rows, "by_agent", chartWin, s.ts, f, agentsAxis);
  inOutChart("chart-inout", rows, s, chartWin, f);   // input vs output $ by model, same pill timeframe
  // model bars removed with the redundant panel — the in/out chart above and
  // the models table cover the same ground
  // REAL money over time: the account balance line — same shared timeframe
  const bc = balanceChart("chart-balance", rows, chartWin, s.ts);
  const bsub = $("bal-chart-sub");
  if(bsub) bsub.textContent = bc
    ? ("$" + bc.first.toFixed(2) + " → $" + bc.last.toFixed(2) +
       "  −$" + bc.delta.toFixed(2) + " over " + (chartWin > 0 ? (chartWin/60) + "h" : "all history") +
       "  ·  " + bc.n + " samples" +
       (ci ? "  ·  agents estimate $" + ci.est.toFixed(2) + " (gap " + (ci.gap*100).toFixed(0) + "%)" : ""))
    : "collecting balance history…";
  renderSessionExplorer(d, d.names||{});
  renderModelsDetail(s, rows, chartWin, f, tokLife);
}

async function load(){
  try{ apply(await (await fetch("/data")).json()); }
  catch(e){ $("stamp").textContent = "load error: " + e.message; }
}

// reset layout: clear saved panel order and restore the default
document.getElementById("reset-layout").addEventListener("click", () => {
  localStorage.removeItem("spendPanelOrder");
  location.reload();
});

// UI controls that re-render from the cached payload (no refetch) except the
// session-name save, which must refetch (names changed server-side)
initCapUI(() => { if(lastData) apply(lastData); });
initSessionUI(() => { if(lastData) apply(lastData); }, load);
initTableSort(() => { if(lastData) apply(lastData); });

// ONE timeframe for the whole page: the agents pills and the balance pills are
// two views of the same selection — changing either drives every widget
// (agents chart, in/out split, model bars, models recent, models full detail).
function paintChartPills(){
  document.querySelectorAll("#chart-pills .pill").forEach(b =>
    b.classList.toggle("active", +b.dataset.win === chartWin));
  document.querySelectorAll("#bal-pills .pill").forEach(b =>
    b.classList.toggle("active", +b.dataset.win === chartWin));
}
document.querySelectorAll("#chart-pills .pill, #bal-pills .pill").forEach(b => {
  b.addEventListener("click", () => {
    chartWin = +b.dataset.win;
    paintChartPills();
    if(lastData) apply(lastData);
  });
});
paintChartPills();

// agents chart: axis toggle (balance <-> spent), persisted
const axBtn = $("agents-axis");
if(axBtn){
  const paint = () => { axBtn.textContent = "axis: " + agentsAxis; };
  paint();
  axBtn.addEventListener("click", () => {
    agentsAxis = agentsAxis === "balance" ? "spent" : "balance";
    try { localStorage.setItem("spendAxis", agentsAxis); } catch(_) {}
    paint();
    if(lastData) apply(lastData);
  });
}

// models table: token/call columns lifetime <-> shared timeframe, persisted
const mdBtn = $("models-detail-toggle");
if(mdBtn){
  const paintMd = () => { mdBtn.textContent = tokLife ? "tokens: lifetime" : "tokens: window"; };
  paintMd();
  mdBtn.addEventListener("click", () => {
    tokLife = !tokLife;
    try { localStorage.setItem("tokLife", tokLife ? "1" : "0"); } catch(_) {}
    paintMd();
    if(lastData) apply(lastData);
  });
}

// calibration toggle (persisted): shows the raw estimates when off
const calT = $("cal-toggle");
if(calT){
  calT.checked = calOn;
  calT.addEventListener("change", () => {
    calOn = calT.checked;
    try { localStorage.setItem("spendCal", calOn ? "1" : "0"); } catch(_) {}
    if(lastData) apply(lastData);
  });
}

// runway window dropdown re-renders from the cached payload
const runwaySel = $("runway-win");
if(runwaySel) runwaySel.addEventListener("change", () => { if(lastData) apply(lastData); });

// burn-rate window dropdown does the same
const rateSel = $("rate-win");
if(rateSel) rateSel.addEventListener("change", () => { if(lastData) apply(lastData); });

// draggable panels: drag a panel title to reorder; order persists locally
(function(){
  const main = document.querySelector("main");
  try{
    const saved = JSON.parse(localStorage.getItem("spendPanelOrder") || "null");
    if(Array.isArray(saved)){
      for(const id of saved){
        const el = document.getElementById(id);
        if(el && el.parentElement === main) main.appendChild(el);
      }
    }
  }catch(_){}
  let dragEl = null;
  document.querySelectorAll("main .panel").forEach(p => {
    const h = p.querySelector("h2");
    if(!h) return;
    h.setAttribute("draggable", "true");
    h.title = "drag to reorder";
    h.addEventListener("dragstart", e => {
      dragEl = p; p.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try{ e.dataTransfer.setData("text/plain", ""); }catch(_){}
    });
    h.addEventListener("dragend", () => {
      dragEl = null;
      document.querySelectorAll("main .panel.dragging").forEach(x => x.classList.remove("dragging"));
      try{
        localStorage.setItem("spendPanelOrder",
          JSON.stringify([...document.querySelectorAll("main .panel")].map(x => x.id)));
      }catch(_){}
    });
    p.addEventListener("dragover", e => {
      e.preventDefault();
      if(!dragEl || dragEl === p) return;
      const r = p.getBoundingClientRect();
      (e.clientY - r.top > r.height/2) ? p.after(dragEl) : p.before(dragEl);
    });
  });
})();

// collapsible panels: a ▾/▸ chevron in each title collapses the body; the
// choice persists. The agents table panel starts COLLAPSED by default.
(function(){
  const KEY = "spendPanelCollapsed";
  let saved = {};
  try{ saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }catch(_){ saved = {}; }
  const DEFAULT_COLLAPSED = { "pane-agents": true };
  document.querySelectorAll("main .panel").forEach(p => {
    const h = p.querySelector("h2");
    if(!h || h.querySelector(".collapse")) return;
    const btn = document.createElement("span");
    btn.className = "collapse";
    btn.setAttribute("draggable", "false");
    btn.title = "collapse / expand";
    h.insertBefore(btn, h.firstChild);
    const sync = () => { btn.textContent = p.classList.contains("collapsed") ? "▸" : "▾"; };
    const want = (p.id in saved) ? saved[p.id] : !!DEFAULT_COLLAPSED[p.id];
    p.classList.toggle("collapsed", want);
    sync();
    btn.addEventListener("mousedown", e => e.stopPropagation());
    btn.addEventListener("click", e => {
      e.stopPropagation();
      p.classList.toggle("collapsed");
      saved[p.id] = p.classList.contains("collapsed");
      try{ localStorage.setItem(KEY, JSON.stringify(saved)); }catch(_){}
      sync();
      // charts drawn in a display:none panel need a resize once shown again —
      // defer so the panel has laid out (0ms is enough, rAF is safer)
      requestAnimationFrame(() => {
        p.querySelectorAll("canvas").forEach(cv => { const c = Chart.getChart(cv); if(c) c.resize(); });
      });
    });
  });
})();

load();
setInterval(load, 60e3);
