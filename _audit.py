#!/usr/bin/env python3
"""Full number-correctness audit of the spend dashboard.

Recomputes every aggregate from the raw ledger and history and compares
against what the /data endpoint (which the UI trusts) actually returns.
"""
import json
import os
import sys
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spenddash import ledger

MIC = 1_000_000
mic = lambda v: int(round(float(v) * MIC))
dol = lambda m: round(m / MIC, 6)
EPS = 5e-7

fails = []
def ok(name, cond, extra=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("   " + extra if extra and not cond else ""))
    if not cond:
        fails.append(name)

d = json.loads(urllib.request.urlopen("http://127.0.0.1:8399/data").read())
s = d["snapshot"]; h = d["history"]
recs = ledger.all_records()

by_agent_m = defaultdict(int); by_model_m = defaultdict(int); by_task_m = defaultdict(int)
tot_m = 0
for r in recs:
    m = mic(r["cost"]); tot_m += m
    by_agent_m[r["agent"]] += m; by_model_m[r["model"]] += m; by_task_m[r["task"]] += m

# --- top-level aggregates ---
ok("ledger_total_cost == sum(rows)", abs(s["ledger_total_cost"] - dol(tot_m)) < EPS)
ok("by_agent == recompute", set(s["by_agent"]) == set(by_agent_m)
   and all(abs(s["by_agent"][k] - dol(v)) < EPS for k, v in by_agent_m.items()))
ok("by_model == recompute", set(s["by_model"]) == set(by_model_m)
   and all(abs(s["by_model"][k] - dol(v)) < EPS for k, v in by_model_m.items()))
ok("by_task == recompute", set(s["by_task"]) == set(by_task_m)
   and all(abs(s["by_task"][k] - dol(v)) < EPS for k, v in by_task_m.items()))
ok("by_agent sums == ledger_total", abs(sum(v for k, v in s["by_agent"].items()) - s["ledger_total_cost"]) < EPS)
ok("by_model sums == ledger_total", abs(sum(v for k, v in s["by_model"].items()) - s["ledger_total_cost"]) < EPS)

# --- model details ---
md = {m["model"]: m for m in s["model_details"]}
ok("model_details costs == by_model", set(md) == set(by_model_m)
   and all(abs(md[k]["cost"] - dol(v)) < EPS for k, v in by_model_m.items()))
tok_ok = all(
    md[k]["calls"] == sum(r["calls"] for r in recs if r["model"] == k) and
    md[k]["in"] == sum(r["in"] for r in recs if r["model"] == k) and
    md[k]["out"] == sum(r["out"] for r in recs if r["model"] == k) and
    md[k]["cache"] == sum(r["cache"] for r in recs if r["model"] == k) and
    md[k]["cw"] == sum(r["cw"] for r in recs if r["model"] == k) and
    md[k]["re"] == sum(r["re"] for r in recs if r["model"] == k)
    for k in by_model_m)
ok("model_details token/calls counts == ledger", tok_ok)

# --- sessions ---
ss = s["sessions"]
ok("sum(session cost) == ledger_total", abs(sum(x["cost"] for x in ss) - dol(tot_m)) < EPS)
bad = [x["session"][:10] for x in ss if abs(x["cost"] - sum(m["cost"] for m in x["models"])) > EPS]
ok("every session cost == sum of its (model,task) rows", not bad, f"bad: {bad}")
ok("sum(session calls) == ledger calls", sum(x["calls"] for x in ss) == sum(r["calls"] for r in recs))
ok("sum(session in) == ledger in", sum(x["in"] for x in ss) == sum(r["in"] for r in recs))
ok("sum(session out) == ledger out", sum(x["out"] for x in ss) == sum(r["out"] for r in recs))
# per-session row counts vs model rows counts
ok("session models row counts == ledger rows",
   all(len(x["models"]) == sum(1 for r in recs if r["session"] == x["session"]) for x in ss))

# --- catalog ---
cat = {c["label"]: c for c in s["catalog"]}
ok("catalog keys == by_agent keys", set(cat) == set(by_agent_m))
ok("catalog cost == by_agent", all(abs(cat[k]["cost"] - dol(v)) < EPS for k, v in by_agent_m.items()))
ok("catalog records == row counts", all(cat[k]["records"] == sum(1 for r in recs if r["agent"] == k) for k in by_agent_m))
ok("sum(catalog) == ledger_total", abs(sum(c["cost"] for c in cat.values()) - s["ledger_total_cost"]) < EPS)
ok("catalog models lists match usage", all(set(cat[k]["models"]) == {r["model"] for r in recs if r["agent"] == k} for k in by_agent_m))

# --- history: monotonic + window delta math (replicate winSlice/keyDelta) ---
rows = [x for x in h if x.get("bucket")]
rows.sort(key=lambda x: x["bucket"])
for x in rows:
    x.setdefault("t", x["ts"])
live = {"t": s["ts"], "bucket": s["bucket"], "by_agent": s["by_agent"],
        "ledger_total_cost": s["ledger_total_cost"], "by_model": s["by_model"]}
if rows and rows[-1]["bucket"] == s["bucket"]:
    rows[-1] = live
else:
    rows.append(live)

# strict: every TOTAL down-step must be covered by a claimed revision
uncovered = []
for i in range(1, len(rows)):
    drop = rows[i-1]["ledger_total_cost"] - rows[i]["ledger_total_cost"]
    if drop > EPS and not ((rows[i].get("cum_rev") or {}).get("total") or 0) >= drop - EPS:
        uncovered.append((rows[i]["bucket"], round(drop, 6)))
ok("history total down-steps all covered by cum_rev (no unexplained drops)",
   not uncovered, f"uncovered: {uncovered}")

def agent_drops_covered():
    for i in range(1, len(rows)):
        prev_ag = rows[i-1].get("by_agent", {})
        cur_ag = rows[i].get("by_agent", {})
        rev = (rows[i].get("cum_rev") or {}).get("by_agent", {})
        for k, pv in prev_ag.items():
            cv = cur_ag.get(k, 0.0)
            if pv - cv > EPS and not (rev.get(k) or 0) >= (pv - cv) - EPS:
                return (k, i)
    return None
bad = agent_drops_covered()
ok("history per-agent down-steps all covered by cum_rev", bad is None, f"bad: {bad}")

def row_sig(row):
    return ",".join(sorted((row.get("by_agent") or {}).keys()))

def win_slice(rows, win_min):
    last = rows[-1]
    start = last["t"] - win_min * 60
    i = len(rows)
    while i > 0 and rows[i-1]["t"] >= start:
        i -= 1
    n = rows[i] if i < len(rows) else None
    b = rows[i-1] if i > 0 else None
    if not b:
        return None
    if not n:
        return {"last": last, "base": b}
    if row_sig(b) != row_sig(last):
        return None            # fleet changed mid-window: no valid baseline
    span = (n["t"] - b["t"]) or 1
    wgt = (start - b["t"]) / span
    def interp(x, y):
        return x + (y - x) * wgt
    base = {}
    for f in ("by_agent", "by_model", "by_task", "ledger_total_cost"):
        A, C = b.get(f), n.get(f)
        if A is None or C is None:
            continue
        if isinstance(A, (int, float)) and isinstance(C, (int, float)):
            base[f] = interp(A, C)
        elif isinstance(A, dict) and isinstance(C, dict):
            o = {}
            for k in set(A) | set(C):
                x, y = A.get(k), C.get(k)
                o[k] = interp(x, y) if (x is not None and y is not None) else (x if x is not None else y)
            base[f] = o
    return {"last": last, "base": base}

def key_delta(sl, field, k):
    if not sl:
        return None
    c = (sl["last"][field] or {}).get(k); b = (sl["base"][field] or {}).get(k)
    return None if c is None or b is None else c - b

for w, label in [(15, "15m"), (60, "1h"), (180, "3h"), (1440, "24h"), (10080, "7d"), (43200, "30d")]:
    sl = win_slice(rows, w)
    if not sl:
        print(f"INFO  window {label}: no baseline -> collecting (expected)")
        continue
    neg = [k for k in sl["last"]["by_agent"] if (v := key_delta(sl, "by_agent", k)) is not None and v < -EPS]
    ok(f"window {label} per-agent deltas never negative", not neg, f"neg: {neg}")
    dlt = sl["last"]["ledger_total_cost"] - sl["base"]["ledger_total_cost"]
    print(f"      {label}: ${dlt:.4f} spend over exactly {w} min")

print()
print(f"records={len(recs)} sessions={len(ss)} history={len(h)} lines")
print(f"ledger_total={s['ledger_total_cost']}  by_agent={ {k: v for k, v in sorted(s['by_agent'].items())} }")
print("FAILS:", fails if fails else "none")
sys.exit(1 if fails else 0)
