"""Ledger reading and aggregation from the Hermes state.db files.

## Connections
- IMPORTS FROM: config (STATE_DBS)
- EXPORTS: read_usage, all_records, build_model_details
- CALLED BY: snapshot
- CALLS: sqlite3, config.STATE_DBS
- CONTRACT: every row dictionary has keys: session, model, task, calls, cost,
  in, out, cache, cw, re, last (epoch seconds) — cost is the row's CUMULATIVE
  lifetime spend (estimate preferred over unsettled actuals) — plus "agent"
  (the label from STATE_DBS). Bucket/time math does NOT belong here; this
  module only reads the ledger and computes lifetime aggregates.
"""
import os
import sqlite3

from . import config

# ---- exact money math -------------------------------------------------------
# Ledger costs are float dollars at micro scale (e.g. 0.000123456). Summing
# them as floats across tens of thousands of rows drifts; every aggregate
# therefore accumulates INTEGER MICRO-DOLLARS (exact) and is only converted
# back to dollars at emission time. This keeps session total == sum of its
# (model,task) rows == sum of raw ledger rows, to the micro.
MICRO = 1_000_000

def _micro(dollars):
    """Float dollar cost -> integer micro-dollars (0.000123456 -> 123456)."""
    try:
        return int(round(float(dollars) * MICRO))
    except (TypeError, ValueError):
        return 0


def _dollars(micro):
    return round(micro / MICRO, 6)


def read_usage(db_path):
    """One dict per (session, model, billing_mode) ledger row.

    Returns None when the DB cannot be read (missing/corrupt/unreachable), so
    callers can DISTINGUISH a genuine empty DB ([]) from a transient failure
    (None) — the snapshot treats the former as zero spend and the latter as
    'carry forward last known totals'.
    """
    rows = []
    try:
        db = sqlite3.connect(db_path)
        cur = db.cursor()
        cur.execute(
            "SELECT session_id, model, task, api_call_count, "
            "estimated_cost_usd, actual_cost_usd, input_tokens, output_tokens, "
            "cache_read_tokens, cache_write_tokens, reasoning_tokens, last_seen "
            "FROM session_model_usage")
        cols = [d[0] for d in cur.description]
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            cost = d["actual_cost_usd"]
            if not cost:
                cost = d["estimated_cost_usd"] or 0.0
            rows.append({
                "session": d["session_id"] or "",
                "model": d["model"] or "?",
                "task": d["task"] or "main",
                "calls": d["api_call_count"] or 0,
                "cost": cost,
                "in": d["input_tokens"] or 0,
                "out": d["output_tokens"] or 0,
                "cache": d["cache_read_tokens"] or 0,
                "cw": d["cache_write_tokens"] or 0,
                "re": d["reasoning_tokens"] or 0,
                "last": d["last_seen"],
            })
        db.close()
    except Exception as e:
        print(f"  read_usage({db_path}) error: {e}")
        return None
    return rows


def all_records():
    """Every ledger row, tagged with its agent label (from STATE_DBS)."""
    records = []
    for db, agent in config.STATE_DBS:
        rows = read_usage(db)
        if rows is None:
            continue                       # unreachable — skip (snapshot carries forward)
        for r in rows:
            r["agent"] = agent
            records.append(r)
    return records


def build_model_details(records):
    """Per-model lifetime aggregates: cost, calls, input/output/cache/reasoning
    tokens. Returns a list sorted by cost desc, each: {model, cost, calls,
    in, out, cache, cw, re}."""
    by_model = {}
    for r in records:
        m = by_model.setdefault(r["model"], {"cost": 0, "calls": 0, "in": 0,
                                             "out": 0, "cache": 0, "cw": 0, "re": 0})
        m["cost"] += _micro(r["cost"])
        m["calls"] += r["calls"]
        m["in"] += r["in"]
        m["out"] += r["out"]
        m["cache"] += r["cache"]
        m["cw"] += r["cw"]
        m["re"] += r["re"]
    details = []
    for k, m in by_model.items():
        d = dict(m, model=k)
        d["cost"] = _dollars(m["cost"])
        details.append(d)
    details.sort(key=lambda x: -x["cost"])
    return details


def build_sessions(records):
    """Session-level spend. Groups ledger rows by session_id; each session has
    an agent label (from STATE_DBS), lifetime aggregates, last activity, and a
    per-(model, task) breakdown. Sorted by total cost desc.

    Session ids are opaque hashes — the dashboard's naming layer (names.py)
    keys off these ids, never off the breakdown."""
    by = {}
    for r in records:
        sid = r["session"]
        s = by.setdefault(sid, {"session": sid, "agent": r["agent"], "cost": 0,
                                "calls": 0, "in": 0, "out": 0, "cache": 0,
                                "cw": 0, "re": 0, "last": r["last"] or 0,
                                "models": {}})
        s["cost"] += _micro(r["cost"])
        s["calls"] += r["calls"]
        s["in"] += r["in"]
        s["out"] += r["out"]
        s["cache"] += r["cache"]
        s["cw"] += r["cw"]
        s["re"] += r["re"]
        if r["last"]:
            s["last"] = max(s["last"], r["last"])
        m = s["models"].setdefault((r["model"], r["task"]), {
            "model": r["model"], "task": r["task"], "cost": 0, "calls": 0,
            "in": 0, "out": 0, "cache": 0, "cw": 0, "re": 0, "last": r["last"] or 0})
        m["cost"] += _micro(r["cost"])
        m["calls"] += r["calls"]
        m["in"] += r["in"]
        m["out"] += r["out"]
        m["cache"] += r["cache"]
        m["cw"] += r["cw"]
        m["re"] += r["re"]
        if r["last"]:
            m["last"] = max(m["last"], r["last"])
    out = []
    for s in by.values():
        for m in s["models"].values():
            m["cost"] = _dollars(m["cost"])
        s["models"] = sorted(s["models"].values(), key=lambda x: -x["cost"])
        s["cost"] = _dollars(s["cost"])
        out.append(s)
    out.sort(key=lambda x: -x["cost"])
    return out
