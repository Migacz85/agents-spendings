// Cards + table renders.
//
// ## Connections
// - IMPORTS FROM: data.js ($, money, collecting, esc, tokCell, an, winSlice,
//   keyDelta, keyRate, getCap, computeRate)
// - EXPORTS: renderCards, renderAgentTable, renderModelsDetail,
//   initTableSort
// - CALLED BY: app.js
// - CALLS: data helpers only (no fetch, no Chart.js)
// - CONTRACT: every windowed figure is a history DELTA (winSlice/keyDelta) —
//   "collecting…" when not yet covered, never invented. The agents table is
//   the dashboard's centerpiece and is SORTABLE: click a column header to
//   sort (click again to flip); sort state is module-local and persisted
//   across re-renders. Per-agent burn rate comes from keyRate over the active
//   short window; "active now" = agent activity within the last 30 min.

import { $, money, collecting, esc, tokCell, tsH, an, winSlice, keyDelta, keyRate, getCap, getRateWin, getRunwayWin, paidSpend, balanceStaleMin, windowTokens } from "./data.js";

const ACTIVE_WINDOW_S = 30 * 60;

// multiply a value by the calibration factor, preserving null (no baseline)
function scale(v, f){ return v == null ? v : v * (f || 1); }

export function renderCards(s, histRows){
  // A window can legitimately be shorter than its label right after the fleet
  // changes: winSlice then baselines off the attach snapshot, and we show the
  // real coverage in the title so a "24h" card never pretends to be a full day.
  const fmtSpan2 = min => min < 60 ? Math.round(min) + "m"
    : min < 1440 ? (min/60).toFixed(1) + "h" : (min/1440).toFixed(1) + "d";
  const fmtHours = h => h < 1 ? Math.round(h*60)+"m" : Math.round(h)+"h";
  const fmtDays = d => d >= 1.9 ? d.toFixed(1)+"d" : Math.round(d*24)+"h";
  const fmtSpan = min => min < 60 ? Math.round(min)+" min" : min < 1440 ? (min/60).toFixed(1)+"h" : (min/1440).toFixed(1)+"d";
  const card = winMin => {
    // REAL money (OpenRouter balance drop) when the window is covered; the
    // per-agent ledger is estimate-based and can lag what was actually paid.
    const paid = paidSpend(histRows, winMin);
    const sl = winSlice(histRows, winMin);
    if(paid == null && !sl) return {html: collecting(), cover: null, paid:false};
    // use paid only when it actually moved; a flat balance (OpenRouter lag)
    // would otherwise show $0.00 while the fleet is clearly spending
    if(paid && paid.spend > 0) return {html: money(paid.spend), cover: paid.coverMin, paid: true};
    const baseAt = sl.online || sl.base.t;
    const coverMin = Math.max(0, (sl.last.t - baseAt) / 60);
    const delta = Math.max(0, (sl.last.ledger_total_cost - sl.base.ledger_total_cost) + (sl.rev?.total || 0));
    return {html: money(delta), cover: coverMin, paid: false};
  };
  const h24 = card(1440), d7 = card(10080), h8 = card(480), h1c = card(60);
  // spent since local midnight (the user's "today": balance drop, ledger fallback)
  const mid = new Date(); mid.setHours(0,0,0,0);
  const dayMin = Math.max(30, (s.ts*1000 - mid.getTime())/60000);
  const dToday = card(dayMin);
  $("c-24h").innerHTML = h24.html;
  $("c-7d").innerHTML = d7.html;
  $("c-8h").innerHTML = h8.html;
  $("c-1h").innerHTML = h1c.html;
  $("c-today").innerHTML = dToday.html;
  $("c-today").title = dToday.paid
    ? "real spend — drop in the OpenRouter account balance since midnight (what you actually paid)"
    : "agents' ledger estimates since midnight (balance API hasn't moved yet — it lags)";
  const hint = (c, full, paid) => paid
    ? "real spend — drop in the OpenRouter account balance (what you actually paid)"
    : c.cover !== null && c.cover < full * 0.9
    ? `only ${c.cover.toFixed(0)} min of fleet history yet (fleet online ${tsH(Date.now()/1000 - c.cover*60)})` : "";
  $("c-24h").title = hint(h24, 1440, h24.paid);
  $("c-7d").title = hint(d7, 10080, d7.paid);
  $("c-8h").title = hint(h8, 480, h8.paid);
  $("c-1h").title = hint(h1c, 60, h1c.paid);
  // burn rate + runway are TOTAL-BASED: take the actual money spent in the
  // selected window and scale from there (balance ÷ spent × window = time until
  // everything is burnt). No per-hour averaging in the headline — the total is
  // what was really spent. Real money (balance drop) when the balance moves;
  // OpenRouter's balance API lags (it can sit flat for hours while usage
  // accrues), so when it's flat we fall back to the live ledger total.
  const winMin = getRateWin(), rwWin = getRunwayWin();
  const bal = (s.balance && s.balance.balance != null) ? s.balance.balance : null;
  const stale = balanceStaleMin(histRows);          // minutes the balance has been flat
  const staleEl = $("c-balstale");
  // neutral wording: a flat balance means no spend was recorded (idle fleet), it
  // is NOT proof of API lag — don't claim a cause we haven't verified
  if(staleEl) staleEl.textContent = (stale != null && stale >= 30)
    ? " · balance unchanged " + fmtSpan2(stale) : "";
  const winTot = m => {
    const p = paidSpend(histRows, m);
    if(p && p.spend > 0) return {total: p.spend, coverMin: Math.max(5, p.coverMin || m), src: "paid"};
    const sl = winSlice(histRows, m);
    if(!sl) return null;
    const v = Math.max(0, (sl.last.ledger_total_cost - sl.base.ledger_total_cost) + ((sl.rev||{}).total || 0));
    if(v <= 0) return null;
    return {total: v, coverMin: Math.max(5, (sl.last.t - sl.base.t)/60), src: "ledger"};
  };
  const rate   = winTot(winMin);
  const rwRate = winTot(rwWin);
  const liveRate = (rate && rate.src) || "ledger";
  if(rate){
    // $/h is the total over the span it ACTUALLY covers — a partial window must
    // not be stretched to the full selected window (that inflated the runway)
    const perH = rate.total / (rate.coverMin/60);
    const rcover = Math.min(winMin, Math.round(rate.coverMin));
    $("c-rate").textContent = "$" + rate.total.toFixed(2);
    $("c-ratewin").textContent = "avg $" + perH.toFixed(2) + "/h"
      + (rcover < winMin ? " · only " + fmtSpan2(rate.coverMin) + " data" : "");
    $("c-rate").title = "total actually spent over the last " + fmtSpan(rate.coverMin) + ": $" + rate.total.toFixed(2)
      + " (" + liveRate + "); that's $" + perH.toFixed(3) + "/h";
  } else {
    $("c-rate").textContent = "—";
    $("c-ratewin").textContent = "idle — no spend in this window";
  }
  // runway uses its own burn window (dropdown in the card)
  if(rwRate && (bal == null || bal > 0)){
    const cap = getCap();
    const coveredH = rwRate.coverMin / 60;                 // hours the total really covers
    const hourEq = rwRate.total / coveredH;               // $/h at the measured rate
    const dayEq = hourEq * 24;                            // what a full day costs
    const winH = rwWin / 60;                              // the SELECTED window, as a unit
    const projWin = rwRate.total * (winH / coveredH);     // spend in the selected window
    // the user's arithmetic, verbatim: balance ÷ spent-in-selected-window ×
    // the window — "spent $15 in 24h, $30 left → 2 days"
    const runH = bal == null ? null : bal / projWin * winH;
    const runCapD = runH == null ? null : runH / cap;     // calendar days at cap h/day
    const fullCov = coveredH >= winH;
    $("c-runway").textContent = runH == null ? "—" : fmtDays(runH / 24);
    $("c-rate2").textContent = "$" + projWin.toFixed(2);
    $("c-cap").textContent = cap + "h";
    $("c-runway-cap").textContent = runCapD == null ? "—" : fmtDays(runCapD);
    $("c-runwaywin").textContent = fmtSpan2(rwWin)
      + (fullCov ? "" : " (~" + fmtSpan2(rwRate.coverMin) + " data)");
    $("c-runway").title = runH == null ? "no balance yet" :
      "Plainly: at this pace your money runs out in ≈" + fmtDays(runH/24) + " (about " + fmtHours(runH) + " of use). "
      + (fullCov
          ? "That's $" + rwRate.total.toFixed(2) + " spent in the last " + fmtSpan(rwWin) + " against your $" + bal.toFixed(2) + " balance."
          : "That's $" + rwRate.total.toFixed(2) + " spent in the last " + fmtSpan(rwRate.coverMin)
            + " (you selected " + fmtSpan(rwWin) + ") ≈ $" + dayEq.toFixed(2) + "/day against your $" + bal.toFixed(2) + " balance.");
    $("c-runway-cap").title = runCapD == null ? "" :
      "Plainly: with use capped at " + cap + "h/day the money stretches to ≈" + fmtDays(runCapD)
      + " instead. That's $" + (hourEq*cap).toFixed(2) + "/day at the measured pace (balance $" + (bal ? bal.toFixed(2) : "—") + ").";
  } else {
    $("c-runway").textContent = "—";
    $("c-rate2").textContent = "—";
    $("c-runwaywin").textContent = "idle — nothing burning in this window";
    $("c-runway-cap").textContent = "—";
    $("c-runway").title = "no measurable burn in the selected window, so runway is undefined";
    $("c-runway-cap").title = "";
  }
  $("c-ledger").textContent = money(s.ledger_total_cost);
}

// ---- sortable agents table ----
let sort = {k: "m15", dir: -1};

export function initTableSort(onChange){
  document.querySelectorAll("#agents-table th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if(sort.k === k) sort.dir *= -1;
      else sort = {k, dir: k === "label" ? 1 : -1};
      onChange();
    });
  });
}

function lastPerAgent(s){
  const m = {};
  for(const sess of (s.sessions||[])){
    const l = sess.last || 0;
    if(!m[sess.agent] || l > m[sess.agent]) m[sess.agent] = l;
  }
  return m;
}

export function renderAgentTable(s, histRows, f = 1){
  const tb = document.querySelector("#agents-table tbody");
  const lastA = lastPerAgent(s);
  const rateWin = getRateWin();
  const now = s.ts;
  const rows = Object.entries(s.by_agent||{})
    .map(([k, life]) => {
      const label = an(k);
      // f = calibration factor (paid/estimated); 1 = raw estimates
      const m5  = scale(keyDelta(winSlice(histRows, 5),    "by_agent", k), f);
      const m10 = scale(keyDelta(winSlice(histRows, 10),   "by_agent", k), f);
      const m15 = scale(keyDelta(winSlice(histRows, 15),   "by_agent", k), f);
      const m30 = scale(keyDelta(winSlice(histRows, 30),   "by_agent", k), f);
      const h1  = scale(keyDelta(winSlice(histRows, 60),   "by_agent", k), f);
      const h2  = scale(keyDelta(winSlice(histRows, 120),  "by_agent", k), f);
      const h3  = scale(keyDelta(winSlice(histRows, 180),  "by_agent", k), f);
      const h4  = scale(keyDelta(winSlice(histRows, 240),  "by_agent", k), f);
      const last = lastA[label] || lastA[k] || 0;
      const rate = scale(histRows.length ? keyRate(histRows, "by_agent", k, rateWin) : null, f);
      const active = last && now - last <= ACTIVE_WINDOW_S;
      return {label, k, life, m5, m10, m15, m30, h1, h2, h3, h4, rate, last, active};
    });
  // Guard: calibrated per-agent values must never sum ABOVE the real (paid)
  // fleet total for the same window — a single agent exceeding the whole fleet
  // is nonsense. If a column overshoots, scale that column down proportionally
  // (keeps the relative shares, guarantees consistency with what was paid).
  const WINK = [["m5",5],["m10",10],["m15",15],["m30",30],["h1",60],["h2",120],["h3",180],["h4",240]];
  for(const [key, mins] of WINK){
    const paidT = paidSpend(histRows, mins);
    if(!paidT || !(paidT.spend > 0)) continue;
    let sum = 0;
    for(const r of rows) sum += (r[key] || 0);
    if(sum > paidT.spend * 1.001){
      const k = paidT.spend / sum;
      for(const r of rows) if(r[key] != null) r[key] *= k;
    }
  }
  const val = r => r[sort.k];
  rows.sort(sort.k === "label"
    ? (a,b) => sort.dir * String(a.label).localeCompare(String(b.label))
    : (a,b) => sort.dir * ((val(a) ?? -1) - (val(b) ?? -1)));
  document.querySelectorAll("#agents-table th.sortable").forEach(th => {
    th.classList.toggle("sorted", th.dataset.k === sort.k);
    th.classList.toggle("desc", th.dataset.k === sort.k && sort.dir < 0);
  });
  // fleet totals row goes ON TOP, above the per-agent breakdown.
  // Uses the REAL account spend (OpenRouter balance drop) when the window is
  // covered — that's what was actually paid; falls back to ledger estimates.
  const tot = m => { const paid = paidSpend(histRows, m); if(paid && paid.spend > 0) return paid.spend;
    const sl = winSlice(histRows, m); if(!sl) return null;
    return scale(Math.max(0, (sl.last.ledger_total_cost - sl.base.ledger_total_cost) + (sl.rev?.total || 0)), f); };
  const totalCells = [5,10,15,30,60,120,180,240]
    .map(m => { const v = tot(m); return `<td class="num">${v == null ? collecting() : money(v)}</td>`; }).join("");
  const totalRow = `<tr class="total-row" title="real spend — drop in the OpenRouter account balance (what you actually paid). Sampled every 5 min, so short windows share that resolution."><td>Total fleet</td>${totalCells}` +
    `<td class="num">100%</td><td></td><td></td><td></td></tr>`;
  tb.innerHTML = totalRow + (rows.length ? rows.map(r => {
    const pct = s.ledger_total_cost ? (100*r.life/s.ledger_total_cost).toFixed(0) : "0";
    return `<tr><td><span class="dot ${r.active ? "on" : "off"}" title="${r.active ? "active in last 30m" : ""}"></span>${esc(r.label)}</td>` +
      `<td class="num">${r.m5 == null ? collecting() : money(r.m5)}</td>` +
      `<td class="num">${r.m10 == null ? collecting() : money(r.m10)}</td>` +
      `<td class="num">${r.m15 == null ? collecting() : money(r.m15)}</td>` +
      `<td class="num">${r.m30 == null ? collecting() : money(r.m30)}</td>` +
      `<td class="num">${r.h1 == null ? collecting() : money(r.h1)}</td>` +
      `<td class="num">${r.h2 == null ? collecting() : money(r.h2)}</td>` +
      `<td class="num">${r.h3 == null ? collecting() : money(r.h3)}</td>` +
      `<td class="num">${r.h4 == null ? collecting() : money(r.h4)}</td>` +
      `<td class="num">${pct}%</td>` +
      `<td class="num">${r.rate == null ? collecting() : "$" + r.rate.toFixed(2) + "/h"}</td>` +
      `<td class="num muted">${r.last ? tsH(r.last) : "—"}</td>` +
      `<td class="num muted">${r.active ? '<span class="badge on">now</span>' : ""}</td></tr>`;
  }).join("") : '<tr><td colspan="13" class="muted">No usage yet</td></tr>');
}

// ---- models: windowed detail (cost by timeframe + lifetime + tokens) ----
export function renderModelsDetail(s, histRows, winMin = 0, f = 1, tokenLifetime = false){
  const tb = document.querySelector("#models-table tbody");
  const winLab = document.querySelector("#models-detail-win-label");
  const allWin = winMin <= 0;                 // 0 = whole history
  const eff = allWin ? 525600 : winMin;
  const mds = s.model_details||[];
  const wl = allWin ? "All" : winMin < 60 ? winMin + "m" : winMin < 1440 ? (winMin/60) + "h" : (winMin/1440) + "d";
  if(winLab) winLab.textContent = allWin ? "All" : "Last " + wl;
  const callsLab = document.querySelector("#models-detail-calls-label");
  if(callsLab) callsLab.textContent = tokenLifetime ? "API calls (life)" : "API calls";
  const sl = winSlice(histRows, eff);
  const wt = windowTokens(histRows, eff);
  const delta = wt ? wt.delta : null;
  const num = v => v == null ? collecting() : v.toLocaleString();
  const tc  = v => v == null ? collecting() : tokCell(v);
  const rows = mds.map(m => {
      // a model absent from the window delta simply had no activity there → 0,
      // not "collecting" (that's only for when NO token history exists at all)
      const ZERO = {in: 0, out: 0, cache: 0, cw: 0, re: 0, calls: 0};
      const d = delta ? (delta[m.model] || ZERO) : null;
      const winCost = sl ? (keyDelta(sl, "by_model", m.model) || 0) : null;
      return {
        model: m.model,
        winCost,
        life: m.cost,
        pct: s.ledger_total_cost ? Math.round(100*m.cost/s.ledger_total_cost) : 0,
        calls: tokenLifetime ? m.calls : (d ? d.calls : null),
        inT: tokenLifetime ? m.in : (d ? d.in : null),
        outT: tokenLifetime ? m.out : (d ? d.out : null),
        cacheT: tokenLifetime ? m.cache : (d ? d.cache : null),
        cwT: tokenLifetime ? m.cw : (d ? d.cw : null),
        reT: tokenLifetime ? m.re : (d ? d.re : null),
      };
    }).filter(r => (r.life || 0) > 0.0005 || (r.winCost || 0) > 0.0005 || r.calls);
  tb.innerHTML = rows.length ? rows.sort((a, b) => (b.life||0) - (a.life||0)).map(r =>
      `<tr><td>${esc(r.model)}</td><td class="num">${r.winCost == null ? collecting() : money((r.winCost||0)*(f||1))}</td>` +
      `<td class="num">${money(r.life)}</td><td class="num">${r.pct}%</td>` +
      `<td class="num">${num(r.calls)}</td><td class="num">${tc(r.inT)}</td><td class="num">${tc(r.outT)}</td>` +
      `<td class="num muted">${tc(r.cacheT)}</td><td class="num muted">${tc(r.cwT)}</td><td class="num muted">${tc(r.reT)}</td></tr>`
    ).join("") : '<tr><td colspan="10" class="muted">No usage yet</td></tr>';
}
