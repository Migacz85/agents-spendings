// Projection panel: current rate -> horizon numbers, with a daily usage cap.
//
// ## Connections
// - IMPORTS FROM: data.js ($, getCap, getRateWin, computeRate)
// - EXPORTS: renderProjection, initCapUI
// - CALLED BY: app.js (render + cap-change re-render)
// - CALLS: data.$ / data.getCap / data.getRateWin / data.computeRate; DOM
//   writes to #proj-box / #proj-sub / #proj-cap-custom
// - CONTRACT: the burn rate comes from data.computeRate over the SELECTED
//   rate window (#rate-win: 30m..4w, shared with the hero cards and the
//   agents tables — one source of truth; the chart pills only change the
//   chart). Hour horizons scale continuously; DAY horizons (7d..28d) assume
//   the model is only active `cap` hours/day -> rate * cap * days. Runway
//   uses the capped daily burn. No history coverage -> "collecting history…".

import { $, getCap, getRateWin, bestRate } from "./data.js";

const HOUR_HORIZONS = [["1h", 1], ["2h", 2], ["4h", 4], ["8h", 8], ["12h", 12], ["24h", 24]];
const DAY_HORIZONS = [["7d", 7], ["14d", 14], ["21d", 21], ["30d", 30]];

export function initCapUI(onChange){
  const sel = $("proj-cap"), cust = $("proj-cap-custom");
  if(!sel) return;
  sel.addEventListener("change", () => {
    cust.style.display = sel.value === "custom" ? "inline-block" : "none";
    onChange();
  });
  cust.addEventListener("change", onChange);
  cust.addEventListener("input", onChange);
}

export function renderProjection(s, histRows){
  const box = $("proj-box");
  const cardsHtml = parts => parts.map(p => `<div class="proj-card"><div class="pc-l">${p[0]}</div><div class="pc-v">${p[1]}</div></div>`).join("");
  const rate = bestRate(s, histRows, getRateWin());
  if(!rate){
    box.innerHTML = '<span class="muted">collecting history…</span>';
    $("proj-sub").textContent = "";
    return;
  }
  if(!(rate.ratePerH > 0)){
    box.innerHTML = '<span class="muted">—</span>';
    $("proj-sub").textContent = "idle — no burn in the selected window (" + getRateWin() + "m)";
    return;
  }
  const cap = getCap();
  const short = HOUR_HORIZONS.map(([l, h]) => [l, "$" + (rate.ratePerH*h).toFixed(2)]);
  const capped = DAY_HORIZONS.map(([l, days]) => [l, "$" + (rate.ratePerH*cap*days).toFixed(2)]);
  box.innerHTML = cardsHtml([...short, ...capped]);

  const bal = (s.balance && s.balance.balance != null) ? s.balance.balance : null;
  let runTxt = "";
  const dailyBurn = rate.ratePerH * cap;
  if(dailyBurn > 0.001 && bal != null && bal > 0){
    const runwayDays = bal / dailyBurn;
    runTxt = " · balance lasts ~" + (runwayDays >= 2 ? runwayDays.toFixed(1)+"d" : Math.round(runwayDays*24)+"h") + " at " + cap + "h/day";
  }
  const capTxt = cap < 24 ? ` · day-horizons capped at ${cap}h/day` : "";
  $("proj-sub").textContent = `rate $${rate.ratePerH.toFixed(3)}/h (last ${rate.elapsedMin.toFixed(0)} min · ${rate.src || "ledger"})` + capTxt + runTxt;
}
