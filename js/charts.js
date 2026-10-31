// Chart builders: line, cumulative per-key chart, horizontal bars.
//
// ## Connections
// - IMPORTS FROM: data.js (winSlice)
// - EXPORTS: line, cumulativeChart, barH, colorOf
// - CALLED BY: app.js (cumulativeChart, barH)
// - CALLS: Chart.js (global from CDN), data.winSlice
// - CONTRACT: cumulativeChart(id, rows, field, winMin, nowS) draws one
//   monotone line per key (totals only grow; baseline = newest snapshot
//   before the window); without a baseline it draws a "collecting history…"
//   placeholder — never a fabricated curve. barH draws horizontal bars of a
//   {label: value} map, top 8 + "others", readable with many slices (donuts
//   are not — that is why they were removed). Chart instances are cached in a
//   module-local registry keyed by canvas id and destroyed on re-render.
//   Colors come from colorOf(), stable per key name.

import { winSlice, inOutSplit, solvedPrices, windowTokens } from "./data.js";

const charts = {};
const PALETTE = ["#4f8cff","#f2a65a","#74d1a1","#e86a6a","#a78bfa","#5ab4c4","#e6c17a","#8b93a3"];
export const colorOf = (() => { const m = {}; let i = 0;
  return k => (k in m) ? m[k] : (m[k] = PALETTE[i++ % PALETTE.length]); })();

export function line(id, labels, sets, fmt){
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), {type:"line", data:{labels, datasets:sets}, options:{
    responsive:true, maintainAspectRatio:false,
    interaction:{mode:"index", intersect:false},
    plugins:{legend:{labels:{color:"#c4cad6", boxWidth:12}}},
    scales:{x:{ticks:{color:"#8b93a3", maxTicksLimit:10}, grid:{color:"#22262e"}},
            y:{ticks:{color:"#8b93a3", callback:fmt}, grid:{color:"#22262e"}}}
  }});
}

// Cumulative per-key chart: history snapshots carry cumulative totals that only
// grow -> monotone lines by construction. Baseline = newest snapshot before
// the window; live snapshot appended by caller. ALL ledger keys are plotted
// (zero-spend agents show a flat line at 0 — hiding them hid agents) — the
// key set is the union of every row in the window, not just nonzero ones.
export function cumulativeChart(id, rows, field, winMin, nowS, f = 1, mode = "balance"){
  // winMin 0 = "all": use a span longer than any history (winSlice baselines on
  // the earliest row of the current agent set) instead of a 0-minute window
  const wm = winMin > 0 ? winMin : 525600;
  const sl = winSlice(rows, wm);
  if(!sl){
    line(id, ["—"], [{label:"collecting history…", data:[0], borderColor:"#8b93a3"}], v=>"$"+v);
    return;
  }
  const start = nowS - wm*60;
  // plot only rows from the CURRENT agent set: when the fleet changed, the
  // attach baseline already holds every current agent's lifetime, so each
  // line starts at 0 at the attach point and grows — never a jump or a dip
  const liveSig = Object.keys(rows[rows.length-1]?.[field]||{}).sort().join("|");
  const inWin = rows.filter(x => x.t >= start
    && Object.keys(x[field]||{}).sort().join("|") === liveSig);
  const keySet = new Set();
  for(const x of inWin) for(const k of Object.keys(x[field]||{})) keySet.add(k);
  const keys = [...keySet];
  let lab;
  if(winMin <= 1440)       lab = b => new Date(b*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  else if(winMin === 10080) lab = b => { const d = new Date(b*1000); return (d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+'h'; };
  else                     lab = b => new Date(b*1000).toLocaleDateString([], {month:'short', day:'numeric'});
  const labels = inWin.map(x => lab(x.bucket));
  // running revision-correction prefix per key, so each point = delta + the
  // estimate->actual corrections recorded up to that row (spend stays >= 0)
  const revPre = [];
  { const acc = {};
    for(const x of inWin){
      for(const f of ["by_agent", "by_model", "by_task"])
        for(const [k, v] of Object.entries((x.cum_rev && x.cum_rev[f]) || {})) acc[k] = (acc[k] || 0) + v;
      revPre.push({...acc});
    }
  }
  // balance-style downward view: each line starts at the account balance at the
  // window start and descends by that agent's (calibrated) spend — reads as
  // "what the balance would be if only this agent had spent". Falls back to
  // plain cumulative (up) lines when no balance history anchors the window.
  const bal0 = (sl.base && sl.base.bal != null) ? sl.base.bal : null;
  const cum = (x, j, k) => Math.max(0, ((x[field]||{})[k]||0) - ((sl.base[field]||{})[k]||0) + (revPre[j][k]||0));
  // per-agent series + their window total (the total goes in the legend label)
  const per = keys.map(k => {
    const series = inWin.map((x, j) => cum(x, j, k) * (f || 1));
    return {k, series, total: series.length ? Math.max.apply(null, series) : 0};
  }).filter(p => p.total > 0.01).sort((a, b) => b.total - a.total);   // biggest band on top; <1c is noise
  if(!per.length){
    line(id, labels, [{label:"no spend in this window",
      data: inWin.map(() => bal0 != null ? bal0 : 0), borderColor:"#8b93a3",
      backgroundColor:"#8b93a311", pointRadius:0, borderWidth:1}], v=>"$"+v.toFixed(2));
    return;
  }
  // the stack must land ON the real balance: calibration (estimates × factor)
  // can overshoot the actual drop, so normalise the bands to it — relative
  // shares are preserved, totals then sum to what was really paid
  const lastBal = rows[rows.length-1].bal;
  const targetDrop = (bal0 != null && lastBal != null) ? Math.max(0, bal0 - lastBal) : null;
  const calTotal = per.reduce((s, p) => s + p.total, 0);
  const g = (targetDrop != null && targetDrop > 0.005 && calTotal > 0.005) ? targetDrop / calTotal : 1;
  if(g !== 1) for(const p of per){ p.series = p.series.map(v => v * g); p.total *= g; }
  // STACKED (waterfall) view: bands hang one under the other, each agent's spend
  // sinking the stack further; the bottom edge lands exactly on the balance
  // (balance at start − total fleet spend). Legend shows each agent's share.
  const sets = [];
  if(mode === "spent"){
    // spend view: stack the SAME bands upward from $0 — the top edge is the
    // money spent in the window (left axis switches from balance to spent)
    const run2 = inWin.map(() => 0);
    for(const p of per){
      for(let j = 0; j < run2.length; j++) run2[j] += p.series[j];
      sets.push({label: p.k + "  $" + p.total.toFixed(2), data: run2.slice(),
        borderColor: colorOf(p.k), backgroundColor: colorOf(p.k) + "33",
        borderWidth: 1.5, pointRadius: 0, spanGaps: true, fill: "-1"});
    }
  } else if(bal0 != null){
    sets.push({label:"balance at start", data: inWin.map(() => bal0),
      borderColor:"#3a4150", backgroundColor:"transparent", borderWidth:1,
      borderDash:[5,4], pointRadius:0, fill:false, spanGaps:true});
    const running = inWin.map(() => 0);
    for(const p of per){
      for(let j = 0; j < running.length; j++) running[j] += p.series[j];
      sets.push({label: p.k + "  −$" + p.total.toFixed(2),
        data: inWin.map((_, j) => bal0 - running[j]),
        borderColor: colorOf(p.k), backgroundColor: colorOf(p.k) + "33",
        borderWidth: 1.5, pointRadius: 0, spanGaps: true, fill: "-1"});
    }
  } else {
    // no balance anchor: plain cumulative up-lines, still labelled with totals
    for(const p of per) sets.push({label: p.k + "  −$" + p.total.toFixed(2), data: p.series,
      borderColor: colorOf(p.k), backgroundColor: colorOf(p.k) + "33",
      borderWidth:1.5, pointRadius:0, spanGaps:true, fill:true});
  }
  // say where the lines actually start: per-agent data may begin later than the
  // balance history (the fleet's agent set changed), so the anchor balance can
  // differ from the balance chart's — explain it instead of leaving it implicit
  const note = document.getElementById("agents-chart-note");
  if(note){
    // only claim partial coverage when the agent data really starts late; once
    // the window is fully covered the note just states the start value (which
    // then matches the balance chart's start for the same window)
    const allMode = !(winMin > 0);
    const late = !allMode && inWin.length > 0 && (inWin[0].t - start) > 900;   // data starts >3 buckets after the window start
    note.textContent = !inWin.length ? ""
      : late
        ? "· lines start " + lab(inWin[0].bucket) + (bal0 != null ? " at $" + bal0.toFixed(2) : "")
          + " — per-agent data begins there (earlier rows had a different agent set)"
        : "· from " + lab(inWin[0].bucket) + (allMode ? " (all history)" : " (window start)")
          + (bal0 != null ? " at $" + bal0.toFixed(2) : "");
  }
  line(id, labels, sets, v=>"$"+v.toFixed(2));
}

// Account balance over time: the REAL money line (OpenRouter credit remaining),
// straight from the 5-min history samples. Complements the per-agent cumulative
// chart, which is ledger/estimate based and can under-count what was paid.
export function balanceChart(id, rows, winMin, nowS){
  const pts = (rows || []).filter(r => r.bal != null);
  if(pts.length < 2){
    line(id, ["—"], [{label:"collecting balance history…", data:[0], borderColor:"#8b93a3"}], v=>"$"+v);
    return null;
  }
  const start = winMin > 0 ? nowS - winMin*60 : 0;
  const inWin = pts.filter(r => r.t >= start);
  const use = inWin.length >= 2 ? inWin : pts;
  const labels = use.map(r => new Date(r.t*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
  const data = use.map(r => r.bal);
  const first = data[0], last = data[data.length-1];
  line(id, labels, [{label:"balance $", data, borderColor:"#74d1a1", backgroundColor:"#74d1a122",
    tension:0, borderWidth:2, pointRadius:0, fill:true}], v=>"$" + Number(v).toFixed(2));
  return {first, last, delta: first - last, n: use.length};
}

export function barH(id, obj){
  if (charts[id]) charts[id].destroy();
  const entries = Object.entries(obj).sort((a,b) => b[1]-a[1]);
  const top = entries.slice(0, 8);
  const restSum = entries.slice(8).reduce((a,[,v]) => a+v, 0);
  const labels = [], vals = [], cols = [];
  const short = k => k.length > 26 ? k.slice(0, 24) + "…" : k;   // long model ids otherwise blow the axis out of the panel
  for(const [k, v] of top){ labels.push(short(k)); vals.push(v.toFixed(2)); cols.push(colorOf(k)); }
  if(restSum > 0){ labels.push("others"); vals.push(restSum.toFixed(2)); cols.push("#8b93a3"); }
  if(!labels.length){ labels.push("none"); vals.push(1); cols.push("#3a4150"); }
  charts[id] = new Chart(document.getElementById(id), {type:"bar", data:{labels, datasets:[{data:vals, backgroundColor:cols, borderColor:cols, borderWidth:1}]}, options:{
    indexAxis:"y", responsive:true, maintainAspectRatio:false,
    plugins:{legend:{display:false}, tooltip:{callbacks:{label: c => "$"+c.parsed.x.toFixed(2)}}},
    scales:{x:{ticks:{color:"#8b93a3", callback:v=>"$"+v}, grid:{color:"#22262e"}},
            y:{ticks:{color:"#aab2bf", font:{size:11}}, grid:{display:false}}}
  }});
}

// Horizontal stacked bars per model: input vs output vs cache vs reasoning $
// in the SAME window as the agents chart above (winMin). Token counts come
// from the history rows' cumulative by_model_tokens (window delta); prices are
// solved from the fleet's own call history (data.solvedPrices) — estimates,
// calibrated like the rest of the ledger figures.
export function inOutChart(id, rows, s, winMin, f = 1){
  if(charts[id]) charts[id].destroy();
  const P = solvedPrices(s);
  const wt = windowTokens(rows, winMin);
  const lbl = document.getElementById("inout-label");
  const spanTxt = wt ? (wt.spanMin < 60 ? Math.round(wt.spanMin) + "m"
    : wt.spanMin < 1440 ? (wt.spanMin/60).toFixed(1) + "h" : (wt.spanMin/1440).toFixed(1) + "d") : null;
  if(lbl) lbl.textContent = spanTxt ? "last " + spanTxt + " of token history" : "collecting token history…";
  let models = [];
  if(wt && Object.keys(wt.delta).length){
    models = Object.entries(wt.delta)
      .map(([m, t]) => { const pr = P[m]; if(!pr) return null;
        return {model: m, in: pr.p[0]*t.in, out: pr.p[1]*t.out, cache: pr.p[2]*t.cache, re: pr.p[3]*t.re}; })
      .filter(Boolean).filter(r => (r.in + r.out + r.cache + r.re) > 0.001)
      .sort((a, b) => (b.in+b.out+b.cache+b.re) - (a.in+a.out+a.cache+a.re));
  }
  const scal = v => v * (f || 1);
  const labels = models.map(r => r.model.length > 28 ? r.model.slice(0, 26) + "…" : r.model);
  const mk = (key, label, color) => ({label, backgroundColor: color, borderColor: color, borderWidth: 0.5,
    data: models.map(r => +scal(r[key]).toFixed(4)), stack: "io", barPercentage: 0.6, categoryPercentage: 0.85});
  const datasets = models.length ? [
    mk("in", "input $", "#4f8cff"), mk("out", "output $", "#74d1a1"),
    mk("cache", "cache $", "#8b93a3"), mk("re", "reasoning $", "#b07cf0")] : [];
  const els = models.length ? models.length : 1;
  charts[id] = new Chart(document.getElementById(id), {type: "bar",
    data: {labels: labels.length ? labels : ["collecting token history…"],
           datasets: datasets.length ? datasets : [{label: "collecting token history…", data: [0.1], backgroundColor: "#3a4150"}]},
    options: {indexAxis: "y", responsive: true, maintainAspectRatio: false,
      scales: {x: {stacked: true, ticks: {color: "#8b93a3", callback: v => "$" + v}, grid: {color: "#22262e"}},
               y: {stacked: true, ticks: {color: "#aab2bf", font: {size: 11}}, grid: {display: false}}},
      plugins: {legend: {labels: {color: "#c4cad6", boxWidth: 10, font: {size: 11}}, display: models.length > 0},
        tooltip: {callbacks: {label: c => c.dataset.label + " $" + Number(c.parsed.x).toFixed(2)}}}}});
}
