#!/usr/bin/env python3
"""Heal a history.jsonl into a strict monotone lifetime series.

Live Hermes DBs rewrite in-flight session estimates every turn, so the raw
cumulative "lifetime" can step DOWN (e.g. the laptop -$0.047 dip) even with
zero settled actuals. A lifetime series must only ever rise, so this rewrites
each row's by_agent (per agent) and ledger_total to never drop below the
previous row's value. Non-destructive: writes a `.bak` beside the input first.

Usage: repair_history.py <history.jsonl>
"""
import json, shutil, sys

path = sys.argv[1]
rows = [json.loads(l) for l in open(path) if l.strip()]
if not rows:
    sys.exit("empty history")

shutil.copy2(path, path + ".bak")

by_max = {}
n_healed_agent = n_healed_total = 0
prev_ledger = 0.0
out = []
for r in rows:
    ag = dict(r.get("by_agent") or {})
    for k, v in list(ag.items()):
        if v < by_max.get(k, 0.0):
            ag[k] = by_max[k]            # carry forward — never dip
            n_healed_agent += 1
        by_max[k] = max(by_max.get(k, 0.0), v if v is not None else 0)
    sum_ag = sum(ag.values())
    r["by_agent"] = {k: v for k, v in sorted(ag.items(), key=lambda x: -x[1])}
    new_ledger = max(prev_ledger, r.get("ledger_total_cost", 0.0) or 0.0, sum_ag)
    # also bump per-key task/model? keep breakdowns raw; only headline heals.
    if new_ledger > prev_ledger and r.get("ledger_total_cost", 0.0) < new_ledger - 1e-9:
        n_healed_total += 1
    r["ledger_total_cost"] = round(new_ledger, 6)
    prev_ledger = new_ledger
    out.append(r)

with open(path, "w") as f:
    for r in out:
        f.write(json.dumps(r) + "\n")
print(f"{path}: {len(out)} rows, {n_healed_agent} agent-key lifts, {n_healed_total} total lifts; backup at {path}.bak")