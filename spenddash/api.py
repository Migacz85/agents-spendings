"""Machine-readable API for agents pulling the dashboard's numbers.

## Connections
- IMPORTS FROM: config (BUCKET_SECONDS), history (load_history)
- EXPORTS: index, summary, agents, models
- CALLED BY: server (/api, /api/summary, /api/agents, /api/models)
- CONTRACT: pure functions of (snapshot dict, history rows, window minutes).
  Money = USD floats. Window figures follow the SAME rules as the UI: REAL
  balance drop when the history covers the window, otherwise the agents' ledger
  delta — `source` always says which. Missing history yields nulls, never
  crashes. Small payloads (a few KB) on purpose: /data is the full blob.
"""
import time

DEFAULT_WIN = 480                     # minutes — matches the UI default (8h)


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _bal(row):
    b = (row or {}).get("balance") or {}
    v = b.get("balance")
    return v if isinstance(v, (int, float)) else None


def _slice(rows, win):
    """(base row, last row) for a window; None when there is no history."""
    if not rows:
        return None, None
    last = rows[-1]
    start = last["ts"] - win * 60
    base = None
    for r in rows:
        if r["ts"] <= start and _bal(r) is not None:
            base = r
    if base is None:                       # window predates history: oldest reading
        base = next((r for r in rows if _bal(r) is not None), None)
    return base, last


def _paid(rows, win):
    base, last = _slice(rows, win)
    if base is None or _bal(last) is None:
        return None
    return {"spent": round(max(0.0, _bal(base) - _bal(last)), 4),
            "covered_minutes": round(max(0.0, (last["ts"] - base["ts"]) / 60), 1),
            "source": "paid"}


def _ledger_delta(rows, win, field, key=None):
    """Spend delta for a field (or a key inside it) across the window."""
    base, last = _slice(rows, win)
    if base is None:
        return None
    def get(d):
        v = d.get(field)
        if key is not None:
            v = (v or {}).get(key)
        return v if isinstance(v, (int, float)) else None
    a, b = get(base), get(last)
    if a is None or b is None:
        return None
    return round(max(0.0, b - a), 4)


def _spend(rows, snap, win):
    """Window spend: real balance drop when available, else ledger delta."""
    p = _paid(rows, win)
    if p and p["spent"] > 0:
        return p
    d = _ledger_delta(rows, win, "ledger_total_cost")
    if d is None:
        return {"spent": None, "covered_minutes": None, "source": None}
    return {"spent": d, "covered_minutes": round(max(0.0, win), 1), "source": "ledger"}


def _stale_minutes(rows):
    bals = [(r["ts"], _bal(r)) for r in rows if _bal(r) is not None]
    if len(bals) < 2:
        return None
    last_t, last_v = bals[-1]
    for t, v in reversed(bals[:-1]):
        if abs(v - last_v) > 1e-9:
            return round((last_t - t) / 60, 1)
    return round((last_t - bals[0][0]) / 60, 1)


def _today_start(now):
    lt = time.localtime(now)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


def index(rows, snap):
    return {
        "ok": True,
        "what": "Hermes fleet spend dashboard — read-only JSON for agents",
        "endpoints": {
            "/api/summary?window=480": "one-shot overview: balance, spend by window, runway, agents, models (small)",
            "/api/agents?window=480": "per-agent spend for the window + lifetime",
            "/api/models?window=480": "per-model spend/tokens for the window + lifetime",
            "/data": "full raw payload (snapshot + every history row) — heavy, use only if you need it",
            "/health": "liveness",
        },
        "notes": [
            "window is in MINUTES (default 480 = 8h); window=0 means all history",
            "spend.source='paid' = real OpenRouter balance drop; 'ledger' = agents' cost estimates (the balance API lags)",
            "all money values are USD floats",
        ],
        "default_window_minutes": DEFAULT_WIN,
        "generated": _iso(snap.get("ts") or time.time()),
    }


def summary(snap, rows, win=None):
    now = snap.get("ts") or time.time()
    if win is None:
        win = DEFAULT_WIN
    bal = snap.get("balance") or {}
    spend = _spend(rows, snap, win)
    today = _spend(rows, snap, max(1, int((now - _today_start(now)) / 60)))
    hours = None
    if spend.get("spent") and bal.get("balance") is not None and spend["spent"] > 0:
        hours = round(bal["balance"] / spend["spent"] * ((spend.get("covered_minutes") or 0) / 60), 2)
    per_agent = []
    for name, life in (snap.get("by_agent") or {}).items():
        per_agent.append({
            "name": name,
            "spent_window": _ledger_delta(rows, win, "by_agent", name),
            "lifetime": round(life, 4),
        })
    per_agent.sort(key=lambda a: a["lifetime"], reverse=True)
    per_model = []
    tot = sum((snap.get("by_model") or {}).values()) or 1
    for model, life in (snap.get("by_model") or {}).items():
        per_model.append({
            "model": model,
            "spent_window": _ledger_delta(rows, win, "by_model", model),
            "lifetime": round(life, 4),
            "share_pct": round(100 * life / tot, 1),
        })
    per_model.sort(key=lambda m: m["lifetime"], reverse=True)
    # the UI reconciles per-agent/model ESTIMATES to paid spend with this factor;
    # API values stay RAW so nothing is silently scaled — consumers can apply it
    paid_p = _paid(rows, win)
    est_d = _ledger_delta(rows, win, "ledger_total_cost")
    factor = None
    if paid_p and est_d and est_d > 0.01 and paid_p["spent"] > 0:
        factor = round(paid_p["spent"] / est_d, 3)
    return {
        "ok": True,
        "generated": _iso(now),
        "generated_epoch": round(now),
        "host": snap.get("host"),
        "window_minutes": win,
        "balance": {
            "balance": bal.get("balance"),
            "credits": bal.get("total_credits"),
            "used": bal.get("total_usage"),
            "stale_minutes": _stale_minutes(rows),
        },
        "spent": {
            "window": spend.get("spent"),
            "covered_minutes": spend.get("covered_minutes"),
            "source": spend.get("source"),
            "today": (today or {}).get("spent"),
            "lifetime_ledger": snap.get("ledger_total_cost"),
        },
        "runway": {
            "window_minutes": win,
            "spent": spend.get("spent"),
            "hours": hours,
            "days": round(hours / 24, 2) if hours else None,
        },
        "agents": per_agent,
        "models": per_model,
        "calibration": {
            "factor": factor,
            "note": "per-agent/per-model values here are RAW ledger estimates; the UI multiplies them by this factor to reconcile with paid spend",
        },
        "records": snap.get("records"),
        "endpoints": {"/api": "this index", "/api/agents": "per-agent", "/api/models": "per-model"},
    }


def agents(snap, rows, win=DEFAULT_WIN):
    now = snap.get("ts") or time.time()
    last_by_agent = {}
    for r in rows[-60:]:
        for name in (r.get("by_agent") or {}):
            last_by_agent[name] = r["ts"]
    out = []
    for name, life in (snap.get("by_agent") or {}).items():
        seen = last_by_agent.get(name)
        out.append({
            "name": name,
            "spent_window": _ledger_delta(rows, win, "by_agent", name),
            "lifetime": round(life, 4),
            "last_seen_minutes_ago": round((now - seen) / 60, 1) if seen else None,
            "active": bool(seen and (now - seen) <= 30 * 60),
        })
    out.sort(key=lambda a: (a["spent_window"] or 0), reverse=True)
    return {"ok": True, "generated": _iso(now), "window_minutes": win,
            "source": "ledger (per-agent splits are cost estimates)", "agents": out}


def models(snap, rows, win=DEFAULT_WIN):
    now = snap.get("ts") or time.time()
    base, last = _slice(rows, win)
    def tok(model):
        if not base or not last:
            return {k: None for k in ("calls", "in", "out", "cache", "cw", "reasoning")}
        b = (base.get("by_model_tokens") or {}).get(model)
        c = (last.get("by_model_tokens") or {}).get(model)
        if b is None or c is None:
            return {k: None for k in ("calls", "in", "out", "cache", "cw", "reasoning")}
        g = lambda k: max(0, (c.get(k) or 0) - (b.get(k) or 0))
        return {"calls": g("calls"), "in": g("in"), "out": g("out"),
                "cache": g("cache"), "cw": g("cw"), "reasoning": g("re")}
    out = []
    tot = sum((snap.get("by_model") or {}).values()) or 1
    for model, life in (snap.get("by_model") or {}).items():
        row = {"model": model,
               "spent_window": _ledger_delta(rows, win, "by_model", model),
               "lifetime": round(life, 4),
               "share_pct": round(100 * life / tot, 1)}
        row.update(tok(model))
        out.append(row)
    out.sort(key=lambda m: m["lifetime"], reverse=True)
    return {"ok": True, "generated": _iso(now), "window_minutes": win,
            "source": "ledger cost estimates; tokens are measured per bucket", "models": out}
