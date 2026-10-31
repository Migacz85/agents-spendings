"""Composes the /data snapshot from ledger + OpenRouter.

## Connections
- IMPORTS FROM: config (BUCKET_SECONDS), ledger (all_records,
  build_model_details), openrouter (openrouter_balance)
- EXPORTS: collect_snapshot
- CALLED BY: server (/data), collector, cli (--once)
- CALLS: ledger.all_records/build_model_details, openrouter.openrouter_balance
- CONTRACT: returns the live snapshot dict with fields the frontend consumes:
  ts, bucket, host, ledger_total_cost, balance {total_credits, total_usage,
  balance}, by_agent {label: lifetime cost}, by_model {model: lifetime cost},
  by_task, model_details (full per-model detail), records. All windowed
  figures are derived CLIENT-SIDE from history.jsonl deltas — the snapshot
  itself carries only lifetime aggregates, never bucket-attributed estimates.
"""
import json
import os
import time
from collections import defaultdict

from . import config, catalog, history, ledger, openrouter

# Last-known per-agent cumulative micro-dollars. When an agent's state.db is
# transiently unreadable (mid-sync, mount hiccup) the snapshot CARRIES THE
# LAST KNOWN TOTALS FORWARD instead of dropping the agent — so by_agent keys
# (and thus the frontend's agent-set signature) stay stable, totals stay
# monotonic, nothing is lost, and a transient glitch never masquerades as an
# attach/detach. Only a real registry change (agents.json) changes the set.
# Persisted to config.LAST_KNOWN so it survives server restarts and --once.
_LAST = {}   # label -> {"micro": int, "by_model": {m: micro}, "by_task": {t: micro}}


def _load_last():
    try:
        with open(config.LAST_KNOWN) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_last():
    tmp = config.LAST_KNOWN + ".tmp"
    with open(tmp, "w") as f:
        json.dump(_LAST, f, indent=2)
    os.replace(tmp, config.LAST_KNOWN)


_LAST = _load_last()


def collect_snapshot():
    now = time.time()
    config.reload_agents()          # agents.json may have changed — hot-swap without restart

    by_agent = defaultdict(int)
    by_model = defaultdict(int)
    by_task = defaultdict(int)
    bmt = defaultdict(lambda: {"in": 0, "out": 0, "cache": 0, "re": 0, "cw": 0, "calls": 0})   # model -> tokens/calls
    total_m = 0
    unreachable = []
    records = []

    for db, label in config.STATE_DBS:
        rows = ledger.read_usage(db)
        if rows is None:
            # transient read failure -> carry the last known cumulative forward
            c = _LAST.get(label)
            am = c["micro"] if c else 0
            if c:
                for k, v in c["by_model"].items():
                    by_model[k] += v
                for k, v in c["by_task"].items():
                    by_task[k] += v
            unreachable.append(label)
        else:
            bm, bt = defaultdict(int), defaultdict(int)
            am = 0
            for r in rows:
                m = ledger._micro(r["cost"]); am += m
                bm[r["model"]] += m; bt[r["task"]] += m
                r["agent"] = label; records.append(r)
                _t = bmt[r["model"]]
                _t["in"] += r.get("in", 0); _t["out"] += r.get("out", 0)
                _t["cache"] += r.get("cache", 0); _t["re"] += r.get("re", 0)
                _t["cw"] += r.get("cw", 0); _t["calls"] += r.get("calls", 0)
            _LAST[label] = {"micro": am, "by_model": dict(bm), "by_task": dict(bt)}
            for k, v in bm.items():
                by_model[k] += v
            for k, v in bt.items():
                by_task[k] += v
        by_agent[label] += am
        total_m += am

    bal = openrouter.openrouter_balance()

    # ---- integrity: record estimate->actual REVISIONS vs the previous row ----
    # Cumulative totals can step DOWN when a settled (lower) actual replaces an
    # estimate. That is a cost correction, not negative spend: we ship the
    # per-field revision deltas with every snapshot (and with every history
    # row), so the frontend can add back the revisions inside any window and
    # prove spend >= 0 while the corrected lifetime stays truthful.
    prev = None
    try:
        _h = history.load_history()
        if _h:
            prev = _h[-1]
    except Exception:
        prev = None
    cum_rev = {"by_agent": {}, "by_model": {}, "by_task": {}, "total": 0.0}
    if prev:
        def rev_map(prev_map, cur_map):
            out = {}
            for k, pv in (prev_map or {}).items():
                cv = (cur_map or {}).get(k, 0.0)
                if cv < pv:
                    out[k] = round(pv - cv, 6)
            return out
        cum_rev["by_agent"] = rev_map(prev.get("by_agent"), by_agent)
        cum_rev["by_model"] = rev_map(prev.get("by_model"), by_model)
        cum_rev["by_task"] = rev_map(prev.get("by_task"), by_task)
        cum_rev["total"] = round(sum(cum_rev["by_agent"].values()), 6)

    # ---- monotone guard: an in-flight session's estimated_cost_usd is
    # rewritten on every turn and can OSCILLATE, so summing a live DB gives a
    # non-monotone "lifetime" (it can step down with zero actuals — exactly the
    # laptop dip). A lifetime spend series must only ever rise: carry the last
    # total forward on a drop. The unclamped drop is already in cum_rev, so the
    # frontend still reports the revision and windowed spend stays >= 0.
    prev_ag_micro = None
    if prev:
        prev_ag_micro = {k: ledger._micro(v) for k, v in (prev.get("by_agent") or {}).items()}
    for label in list(by_agent):
        pm = prev_ag_micro.get(label) if prev_ag_micro else None
        if pm is not None and by_agent[label] < pm:
            by_agent[label] = pm
    total_m = sum(by_agent.values())

    return {
        "ts": now,
        "bucket": int(now // config.BUCKET_SECONDS) * config.BUCKET_SECONDS,
        "host": "laptop",
        "ledger_total_cost": ledger._dollars(total_m),
        "balance": {"total_credits": bal["total_credits"],
                    "total_usage": bal["total_usage"],
                    "balance": bal["balance"]},
        "agents": sorted(l for _db, l in config.STATE_DBS),
        "unreachable": unreachable,
        "cum_rev": cum_rev,
        "by_agent": {k: ledger._dollars(v) for k, v in sorted(by_agent.items(), key=lambda x: -x[1])},
        "by_model": {k: ledger._dollars(v) for k, v in sorted(by_model.items(), key=lambda x: -x[1])},
        "by_model_tokens": {k: dict(v) for k, v in bmt.items()},
        "by_task": {k: ledger._dollars(v) for k, v in sorted(by_task.items(), key=lambda x: -x[1])},
        "model_details": ledger.build_model_details(records),
        "sessions": ledger.build_sessions(records),
        "catalog": catalog.build_catalog(records),
        "records": len(records),
    }
