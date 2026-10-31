// Data layer: fetch, history normalization, windowing math, formatting,
// rate/cap helpers shared by cards, tables and projection.
//
// ## Connections
// - IMPORTS FROM: nothing (pure browser JS)
// - EXPORTS: $, money, collecting, tokCell, esc, tsH, an, buildRows, winSlice,
//   keyDelta, keyRate, getCap, DEFAULT_CAP, computeRate
// - CALLED BY: app.js; charts.js (winSlice); tables.js (winSlice, keyDelta,
//   keyRate, getCap, computeRate, money, ...); projection.js (getCap,
//   computeRate); sessions.js ($, money, ...)
// - CALLS: fetch("/data") via app.js (this module stays side-effect free
//   except getCap, which only reads two DOM ids)
// - CONTRACT: history row shape is {t (epoch s), bucket, by_agent, by_model,
//   ledger_total_cost}; buildRows sorts + remaps legacy agent keys + appends
//   the live snapshot. winSlice returns {last, base} ONLY when a baseline
//   snapshot exists before the window — every windowed figure must come from
//   these deltas, never invented. computeRate/keyRate = deltas over the
//   active short window (+300s grace so 5m windows catch their baseline pair).

export const $ = id => document.getElementById(id);

export const money = x => {
  if(x == null) return "—";
  const m = Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4);
  const clean = m.replace(/0+$/, "").replace(/\.$/, "");
  return "$" + (parseFloat(clean) === 0 ? x.toFixed(2) : clean);
};
export const collecting = () => '<span class="muted">collecting…</span>';
export const tsH = b => new Date(b*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

const fmtTok = x => !x ? "0" : x>=1e9 ? (x/1e9).toFixed(2)+"B" : x>=1e6 ? (x/1e6).toFixed(2)+"M" : x>=1e3 ? (x/1e3).toFixed(1)+"K" : String(x);
export const tokCell = x => `<span title="${Number(x).toLocaleString()}">${fmtTok(x)}</span>`;

export const esc = x => String(x).replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// Legacy history snapshots used heuristic names; remap to per-DB labels:
// old "core2/twin"/"agent" were the DEFAULT db spend (= laptop),
// old "default" was the twin db spend (= core2).
const AGENT_MAP = {"core2/twin": "laptop", "agent": "laptop", "default": "core2"};
export const an = k => AGENT_MAP[k] || k;
const remapAgents = o => { const r = {}; for (const k in (o||{})) r[an(k)] = o[k]; return r; };

// Sorted history rows + the live snapshot appended (dedup on same bucket).
export function buildRows(d){
  const s = d.snapshot;
  const h = (d.history||[]).filter(x=>x.bucket).sort((a,b)=>a.bucket-b.bucket);
  const bal = x => (x && x.balance && x.balance.balance != null) ? x.balance.balance : null;
  const rows = h.map(x => ({t:x.ts, bucket:x.bucket, by_agent: remapAgents(x.by_agent),
    by_model:x.by_model, ledger_total_cost:x.ledger_total_cost,
    cum_rev: x.cum_rev || null, bal: bal(x), bmt: x.by_model_tokens || null}));
  const live = {t:s.ts, bucket:s.bucket, by_agent: remapAgents(s.by_agent),
    by_model:s.by_model, ledger_total_cost:s.ledger_total_cost,
    cum_rev: s.cum_rev || null, bal: bal(s), bmt: s.by_model_tokens || null};
  if(rows.length && rows[rows.length-1].bucket === s.bucket) rows[rows.length-1] = live;
  else rows.push(live);
  return rows;
}

// Per-model per-token PRICES solved from the fleet's own call history:
// least squares over every session-record (cost = p_in*in + p_out*out +
// p_cache*cache + p_re*re). Returns {model: {p: [pin,pout,pcache,pre], tot}}.
export function solvedPrices(s){
  const recs = {};                         // model -> aggregated {cost,in,out,cache,re}
  const rows = {};                         // model -> [[cost,in,out,cache,re], ...]
  for(const ss of (s.sessions || [])) for(const m of (ss.models || [])){
    const k = m.model;
    (rows[k] = rows[k] || []).push([m.cost||0, m.in||0, m.out||0, m.cache||0, m.re||0]);
    const a = recs[k] = recs[k] || {cost:0,in:0,out:0,cache:0,re:0};
    a.cost += m.cost||0; a.in += m.in||0; a.out += m.out||0; a.cache += m.cache||0; a.re += m.re||0;
  }
  // least squares via normal equations (4 unknowns), gaussian elimination
  function solve(A, b){
    const n = 4;
    const AtA = Array.from({length:n}, (_, i) => Array.from({length:n}, (_, j) =>
      A.reduce((acc, r) => acc + r[i]*r[j], 0)));
    const Atb = Array.from({length:n}, (_, i) => A.reduce((acc, r, k) => acc + r[i]*b[k], 0));
    const M = AtA.map((row, i) => row.concat(Atb[i]));
    for(let col = 0; col < n; col++){
      let piv = col;
      for(let r = col+1; r < n; r++) if(Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      const t = M[col]; M[col] = M[piv]; M[piv] = t;
      for(let r = col+1; r < n; r++){
        const f = M[col][col] ? M[r][col]/M[col][col] : 0;
        for(let c = col; c <= n; c++) M[r][c] -= f*M[col][c];
      }
    }
    const x = new Array(n).fill(0);
    for(let r = n-1; r >= 0; r--){
      let v = M[r][n];
      for(let c = r+1; c < n; c++) v -= M[r][c]*x[c];
      x[r] = M[r][r] ? v/M[r][r] : 0;
    }
    return x.map(v => Math.max(0, v));
  }
  const prices = {};
  for(const [model, rr] of Object.entries(rows)){
    const A = [], b = [];
    for(const r of rr){ const [cost, i, o, c, re] = r; if(cost > 0 && i+o+c+re > 0){ A.push([i, o, c, re]); b.push(cost); } }
    if(A.length < 4) continue;
    let p;
    try { p = solve(A, b); } catch(_) { continue; }
    if(!p.some(v => v > 0)) continue;
    prices[model] = {p, tot: recs[model]};
  }
  return prices;
}

// Split each model's cost into input/output/cache/reasoning DOLLARS (lifetime,
// from solvedPrices). Models with <4 priced records are omitted.
export function inOutSplit(s){
  const P = solvedPrices(s);
  const out = [];
  for(const [model, {p, tot}] of Object.entries(P))
    out.push({model, in: p[0]*tot.in, out: p[1]*tot.out, cache: p[2]*tot.cache, re: p[3]*tot.re, total: tot.cost});
  out.sort((x, y) => (y.in+y.out+y.cache+y.re) - (x.in+x.out+x.cache+x.re));
  return out;
}

// Window TOKEN deltas per model, from the cumulative by_model_tokens that
// history rows carry since 2026-10-31 (older rows have none). Baseline = the
// latest row with tokens at or before the window start; falls back to the
// earliest token-carrying row when the window predates token tracking.
export function windowTokens(rows, winMin){
  const withT = (rows || []).filter(r => r.bmt);
  if(withT.length < 2) return null;
  const last = withT[withT.length-1];
  const wm = winMin > 0 ? winMin : 525600;
  const start = last.t - wm*60;
  let base = null;
  for(const r of withT){ if(r.t <= start) base = r; }
  if(!base) base = withT[0];
  if(base === last) return null;
  const delta = {};
  for(const [m, b] of Object.entries(base.bmt || {})){
    const c = last.bmt[m]; if(!c) continue;
    // a field missing from the BASE row was never tracked there (older rows) —
    // its delta is UNKNOWN (null), not zero: showing a full lifetime count as
    // a window delta would be a lie
    const num = (x, y) => (x == null || y == null) ? null : Math.max(0, y - x);
    const din = num(b.in, c.in), dout = num(b.out, c.out), dca = num(b.cache, c.cache);
    const dre = num(b.re, c.re), dcw = num(b.cw, c.cw), dcal = num(b.calls, c.calls);
    if(din === null && dout === null && dca === null && dre === null && dcw === null && dcal === null) continue;
    if((din || 0) <= 0 && (dout || 0) <= 0 && (dca || 0) <= 0 && (dre || 0) <= 0 && (dcw || 0) <= 0 && (dcal || 0) <= 0) continue;
    delta[m] = {in: din, out: dout, cache: dca, re: dre, cw: dcw, calls: dcal};
  }
  return {delta, spanMin: Math.max(0, (last.t - base.t)/60)};
}

// REAL money spent in a window: the drop in the OpenRouter account balance
// (5-min history rows carry balance). This is what was actually PAID — unlike
// the ledger totals, which are per-agent estimates. null when the window isn't
// covered by balance history yet, so callers can fall back to the ledger.
export function paidSpend(rows, winMin){
  if(!rows || !rows.length) return null;
  const last = rows[rows.length-1];
  if(last.bal == null) return null;
  const start = last.t - winMin*60;
  let base = null;
  for(const r of rows){ if(r.t <= start && r.bal != null) base = r; }
  // window not covered by balance history -> use the OLDEST balance reading we
  // have (the value is still real money, just over a shorter span; coverMin
  // tells the caller how far back it actually reaches)
  if(!base) base = rows.find(r => r.bal != null);
  if(!base) return null;
  return {spend: Math.max(0, base.bal - last.bal),      // a top-up raises balance; never negative
          coverMin: Math.max(0, (last.t - base.t)/60)};
}

// Burn rate from REAL money: balance drop per hour over the window. Elapsed is
// the balance rows' actual span, so it's directly comparable to the ledger rate.
export function paidRate(rows, winMin){
  if(!rows || !rows.length) return null;
  const last = rows[rows.length-1];
  if(last.bal == null) return null;
  const start = last.t - winMin*60;
  let base = null;
  for(const r of rows){ if(r.t <= start && r.bal != null) base = r; }
  if(!base) base = rows.find(r => r.bal != null);
  if(!base) return null;
  const spend = Math.max(0, base.bal - last.bal);
  const elapsedMin = Math.max((last.t - base.t)/60, 1);
  return {ratePerH: spend/(elapsedMin/60), elapsedMin};
}

// minutes since the account balance last changed (OpenRouter's balance API
// lags — it can sit flat for hours while usage accrues, so short balance-derived
// windows go to 0 and the burn rate would read 0/h). null when unknown.
export function balanceStaleMin(rows){
  if(!rows || !rows.length) return null;
  const bal = rows.map(r => r.bal).filter(v => v != null);
  if(bal.length < 2) return null;
  const last = bal[bal.length-1];
  for(let i = bal.length - 1; i > 0; i--){
    if(Math.abs(bal[i] - bal[i-1]) > 1e-9){
      return (rows[rows.length-1].t - rows[i].t) / 60;
    }
  }
  return (rows[rows.length-1].t - rows[0].t) / 60;   // flat across all history
}

// One rate for every card/panel: REAL money when the balance actually moved,
// else the live ledger rate. Keeps the hero cards, runway and projection from
// disagreeing (they used different sources before). Returns null when idle.
export function bestRate(s, rows, winMin){
  const paid = paidRate(rows, winMin);
  if(paid && paid.ratePerH > 0) return {...paid, src: "paid"};
  const led = computeRate(s, rows, winMin);
  if(led && led.ratePerH > 0) return {...led, src: "ledger"};
  return paid || led || null;
}

// CALIBRATION (transparent): per-agent numbers come from Hermes' ESTIMATES
// (cost_status='estimated' priced from the provider's model price list), which
// run below the real bill. Over the span where both are measurable we compute
// factor = paid / estimated, so the per-agent figures can be shown reconciled
// to what was actually charged — and the factor is displayed, never hidden.
// Measured over the SAME span for both: from the earliest row with the current
// agent set (post fleet-attach) to now. Clamped to a sane 0.5..3.0 range.
export function calInfo(rows){
  if(!rows || rows.length < 3) return null;
  const last = rows[rows.length-1];
  if(last.bal == null) return null;
  const sig = Object.keys(last.by_agent || {}).sort().join("|");
  let base = null;
  for(const r of rows){
    if(Object.keys(r.by_agent || {}).sort().join("|") === sig){ base = r; break; }
  }
  if(!base || base === last || base.bal == null) return null;
  const paid = Math.max(0, base.bal - last.bal);
  const est  = Math.max(0, last.ledger_total_cost - base.ledger_total_cost);
  if(est <= 0.01 || paid <= 0) return null;
  const raw = paid / est;
  return {factor: Math.max(0.5, Math.min(3, raw)), raw, paid, est,
          gap: est > 0 ? (paid - est) / paid : 0, since: base.t};
}

// Sorted agent keys = the row's "set signature". Deltas/rates are only valid
// between rows with the SAME signature: when the fleet changes (agent
// joined/left), the cumulative totals jump by the newcomers' LIFETIME spend
// — that jump is a new baseline, never burn. Signatures keep old rows in the
// file (data preserved) while every window crossing the change honestly
// degrades to "collecting…" until two same-signature rows exist.
export const rowSig = r => {
  const ks = Object.keys(r.by_agent || {}).sort();
  return ks.join("\u0001");
};

// Earliest history row with the given signature — the "attach baseline": the
// first snapshot after the fleet changed, which already contains every
// current agent's LIFETIME totals. Deltas against it measure only spend
// SINCE the change (real, non-fabricated) and never the one-time lifetime
// jump. null if no such row exists yet (= the change just happened, no data).
function sameSigEarliest(rows, sig){
  for(const x of rows) if(rowSig(x) === sig) return x;
  return null;
}

// {last, base} for a window, or null when history doesn't reach back that far.
// base = the cumulative totals LINEARLY INTERPOLATED to exactly (last.t - winMin*60),
// using the two snapshots straddling that timestamp — so a "1h" window really is
// 1h of spend, not 60-65 min depending on bucket alignment.
// Sum of estimate->actual revisions recorded strictly AFTER the base row up
// to the last row. A window's spend = raw delta + these revisions (a drop in
// the cumulative from a settled actual is a cost correction, paid usage was
// already spent) — this makes every windowed figure provably >= 0.
function sumRevs(rows, baseIdx){
  const rev = {by_agent:{}, by_model:{}, by_task:{}, total:0};
  for(let j = baseIdx + 1; j < rows.length; j++){
    const r = rows[j].cum_rev;
    if(!r) continue;
    rev.total += r.total || 0;
    for(const f of ["by_agent", "by_model", "by_task"]){
      for(const [k, v] of Object.entries(r[f] || {})) rev[f][k] = (rev[f][k] || 0) + v;
    }
  }
  return rev;
}

export function winSlice(rows, winMin){
  if(!rows || !rows.length) return null;
  const last = rows[rows.length-1];
  const start = last.t - winMin*60;
  let i = rows.length;
  while(i > 0 && rows[i-1].t >= start) i--;      // first row with t >= start
  const n = rows[i];                              // straddle: n at/after start
  const b = rows[i-1];                            //         b before start
  if(i === 0){
    // window starts BEFORE the recorded history: baseline = earliest row, so
    // the delta is the spend across the whole recorded span (never a wrong
    // "b = last row" self-zero). Same-set guard: fall back to the attach row.
    if(rowSig(rows[0]) !== rowSig(last)){
      const online = sameSigEarliest(rows, rowSig(last));
      if(!online) return null;
      return {last, base: online, online: online.t, rev: sumRevs(rows, rows.indexOf(online))};
    }
    return {last, base: rows[0], rev: sumRevs(rows, 0)};
  }
  if(!b) return null;
  if(!n) return {last, base: b, rev: sumRevs(rows, 0)};   // whole history before start
  if(rowSig(b) !== rowSig(last)){
    // fleet changed inside the window: no interpolable baseline, but use the
    // attach baseline (earliest row with the CURRENT set) so callers still
    // get real spend SINCE the change instead of "collecting…" for hours.
    const online = sameSigEarliest(rows, rowSig(last));
    if(!online || online.t > last.t) return null;
    const oi = rows.indexOf(online);
    return {last, base: online, online: online.t, rev: sumRevs(rows, oi)};
  }
  const span = (n.t - b.t) || 1;
  const wgt = (start - b.t) / span;
  const interpNum = (v0, v1) => v0 + (v1 - v0) * wgt;
  const base = {};
  for(const f of ["by_agent", "by_model", "by_task", "ledger_total_cost", "bal"]){
    const A = b[f], C = n[f];
    if(A == null || C == null) continue;
    if(typeof A === "number" && typeof C === "number"){
      base[f] = interpNum(A, C);
    } else if(typeof A === "object" && typeof C === "object"){
      const o = {};
      for(const k of new Set([...Object.keys(A), ...Object.keys(C)])){
        const x = A[k], y = C[k];
        // key must exist in BOTH straddlers: a single-sided value gives no
        // baseline (agent joined/left mid-history) -> undefined -> delta null
        // -> callers show "collecting…", never a fabricated number
        o[k] = (x == null || y == null) ? undefined : interpNum(x, y);
      }
      base[f] = o;
    }
  }
  return {last, base, rev: sumRevs(rows, i - 1)};
}

// Spend of key k inside a window (delta of cumulative totals), or null.
// Revision-aware: a settled (lower) actual is added back so spend is never
// negative; the floor at 0 is belt-and-suspenders.
export function keyDelta(sl, field, k){
  if(!sl) return null;
  const c = (sl.last[field]||{})[k], b = (sl.base[field]||{})[k];
  if(c == null || b == null) return null;
  const rev = (sl.rev && sl.rev[field] ? sl.rev[field][k] : 0) || 0;
  return Math.max(0, c - b + rev);
}

// Burn rate of key k ($/h) over the short window (+300s grace), or null.
export function keyRate(rows, field, k, winMin){
  if(!rows || rows.length < 2) return null;
  const start = rows[rows.length-1].t - winMin*60 - 300;
  const win = rows.filter(x => x.t >= start);
  if(win.length < 2) return null;
  let f = win[0], l = win[win.length-1];
  if(rowSig(f) !== rowSig(l)){
    // attach happened inside the window: measure from the attach baseline
    const online = sameSigEarliest(rows, rowSig(l));
    if(!online || online === l) return null;
    f = online;
  }
  let delta = ((l[field]||{})[k]||0) - ((f[field]||{})[k]||0);
  // revisions between f..l add back (cost corrections, not spend)
  delta += sumRevs(rows, rows.indexOf(f))[field][k] || 0;
  if(delta <= 0) return 0;
  const elapsedH = Math.max((l.t - f.t)/3600, 1/60);
  return delta / elapsedH;
}

// Overall burn rate over the active short window (like keyRate on the total).
export function computeRate(s, histRows, winMin){
  if(!histRows || histRows.length < 2) return null;
  const start = s.ts - winMin*60 - 300;
  const win = histRows.filter(x => x.t >= start);
  if(win.length < 2) return null;
  let f = win[0], l = win[win.length-1];
  if(rowSig(f) !== rowSig(l)){
    // attach happened inside the window: measure from the attach baseline
    const online = sameSigEarliest(histRows, rowSig(l));
    if(!online || online === l) return null;
    f = online;
  }
  let spend = (l.ledger_total_cost||0) - (f.ledger_total_cost||0);
  spend += sumRevs(histRows, histRows.indexOf(f)).total || 0;   // revisions are corrections, not spend
  spend = Math.max(spend, 0);
  const elapsedMin = Math.max((l.t - f.t)/60, 1);
  return {ratePerH: spend / (elapsedMin/60), elapsedMin};
}

export const DEFAULT_CAP = 8;
export function getCap(){
  const sel = $("proj-cap");
  if(!sel) return DEFAULT_CAP;
  const n = sel.value === "custom" ? parseInt($("proj-cap-custom").value) : parseInt(sel.value);
  return (n >= 1 && n <= 24) ? n : DEFAULT_CAP;
}

export const DEFAULT_RATE_WIN = 30;   // minutes
export function getRateWin(){
  const sel = $("rate-win");
  const n = sel ? parseInt(sel.value) : NaN;
  return (n >= 5 && n <= 40320) ? n : DEFAULT_RATE_WIN;
}

// Runway card has its own burn-window dropdown (15m .. month). Windows beyond
// the balance history cover just as far back as the history — that's displayed.
export function getRunwayWin(){
  const sel = $("runway-win");
  const n = sel ? parseInt(sel.value) : NaN;
  return (n >= 5 && n <= 43200) ? n : DEFAULT_RATE_WIN;
}
