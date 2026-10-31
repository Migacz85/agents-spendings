// Session explorer: agent -> session drill-down with per-session spend table
// and persistent session naming.
//
// ## Connections
// - IMPORTS FROM: data.js ($, money, tokCell, esc, tsH)
// - EXPORTS: renderSessionExplorer, initSessionUI
// - CALLED BY: app.js (render + UI wiring)
// - CALLS: data helpers; fetch POST /name (session naming); app reload via
//   optional onSaved callback passed to initSessionUI
// - CONTRACT: sessions come from the backend snapshot (s.sessions), names from
//   d.names. Selection state (agent + session ids) is kept module-local and
//   PRESERVED across re-renders when still valid. The table shows the selected
//   session's per-(model, task) rows plus a totals row; every figure comes
//   from the ledger aggregates, never invented. Naming: POST {session, name};
//   empty name clears it.

import { $, money, tokCell, esc, tsH } from "./data.js";

const st = { agent: null, session: null };
const shortId = s => s.length > 30 ? s.slice(0, 12) + "…" + s.slice(-8) : s;

function sessionsOf(data){
  // {agent: [sessions sorted by cost desc]}
  const map = {};
  for(const s of data.sessions||[]){
    (map[s.agent] = map[s.agent] || []).push(s);
  }
  return map;
}

function fillSelect(el, options, value){
  el.innerHTML = "";
  for(const [v, label] of options){
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    if(v === value) o.selected = true;
    el.appendChild(o);
  }
}

export function renderSessionExplorer(data, names){
  const s = data.snapshot;
  const byAgent = sessionsOf(s);
  const agents = Object.keys(byAgent).sort();
  if(!st.agent || !byAgent[st.agent]) st.agent = agents[0] || null;
  if(!agents.length){ $("ses-agent").innerHTML = '<option>no sessions</option>'; return; }

  fillSelect($("ses-agent"), agents.map(a => [a, a]), st.agent);
  const list = (byAgent[st.agent]||[]).slice().sort((a,b) => b.cost - a.cost);
  if(!list.length){ st.session = null; $("ses-session").innerHTML = '<option>—</option>'; return; }
  if(!st.session || !list.some(x => x.session === st.session)) st.session = list[0].session;
  fillSelect($("ses-session"), list.map(x => [x.session,
    (names[x.session] ? names[x.session] + " — " : "") + shortId(x.session) + " · $" + x.cost.toFixed(2)]), st.session);

  const sel = list.find(x => x.session === st.session);
  $("ses-name").value = names[st.session] || "";
  if(!sel){ document.querySelector("#sessions-table tbody").innerHTML = '<tr><td colspan="9" class="muted">select a session</td></tr>'; return; }

  const rows = sel.models.map(m =>
    `<tr><td>${esc(m.model)}</td><td>${esc(m.task)}</td>` +
    `<td class="num">${m.calls.toLocaleString()}</td><td class="num">${money(m.cost)}</td>` +
    `<td class="num">${tokCell(m.in)}</td><td class="num">${tokCell(m.out)}</td>` +
    `<td class="num muted">${tokCell(m.cache)}</td><td class="num muted">${tokCell(m.re)}</td>` +
    `<td class="num muted">${m.last ? tsH(m.last) : "—"}</td></tr>`);
  rows.push(`<tr class="total-row"><td>${esc(names[st.session] || shortId(st.session))}</td><td>TOTAL</td>` +
    `<td class="num">${sel.calls.toLocaleString()}</td><td class="num">${money(sel.cost)}</td>` +
    `<td class="num">${tokCell(sel.in)}</td><td class="num">${tokCell(sel.out)}</td>` +
    `<td class="num muted">${tokCell(sel.cache)}</td><td class="num muted">${tokCell(sel.re)}</td>` +
    `<td class="num muted">${sel.last ? tsH(sel.last) : "—"}</td></tr>`);
  document.querySelector("#sessions-table tbody").innerHTML = rows.join("");
}

export function initSessionUI(onChange, onAfterSave){
  $("ses-agent").addEventListener("change", e => {
    st.agent = e.target.value; st.session = null;
    onChange();   // full re-render with current data
  });
  $("ses-session").addEventListener("change", e => {
    st.session = e.target.value;
    onChange();
  });
  $("ses-save").addEventListener("click", async () => {
    if(!st.session) return;
    await fetch("/name", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({session: st.session, name: $("ses-name").value}),
    });
    onAfterSave();   // REFETCH — names changed server-side, cached payload is stale
  });
  $("ses-name").addEventListener("keydown", e => { if(e.key === "Enter") $("ses-save").click(); });
}
