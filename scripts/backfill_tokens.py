"""One-off backfill: give past history rows a by_model_tokens field.

WHY: per-bucket token history only started being recorded on 2026-10-31, but the
ledger has always held per-model token totals. Without this, the input/output
chart shows "collecting token history…" for every window older than the start
of per-bucket recording.

HOW (honest approximation): each ledger record is a per-(agent, session, model,
task) aggregate carrying `last` (its last activity). We attribute that record's
tokens to the history bucket at its last activity, so for bucket T:
    by_model_tokens[T][model] = Σ tokens of records with last <= T
This is a cumulative, monotone series that ends exactly at the lifetime totals.
Window deltas therefore mean "tokens of sessions whose activity ended inside
that window" — an attribution, not a 5-minute measurement. Rows keep every
other field untouched.

Usage (on the dashboard host, inside the app dir):
    python3 scripts/backfill_tokens.py [--dry-run]
"""
import bisect
import json
import os
import sys

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP_DIR)

from spenddash import config, history, ledger  # noqa: E402

FIELDS = ("in", "out", "cache", "re", "cw", "calls")


def main():
    dry = "--dry-run" in sys.argv
    rows = history.load_history()
    if not rows:
        print("no history rows")
        return

    try:
        recs = ledger.all_records()      # already iterates STATE_DBS, skips unreachable
    except Exception as e:               # an unreadable DB must not abort the backfill
        print("  all_records failed: %s" % e)
        recs = []

    # model -> sorted [(last_ts, {field: value}), ...]
    events = {}
    for r in recs:
        t = r.get("last") or 0
        if not t:
            continue
        events.setdefault(r["model"], []).append(
            (t, {f: (r.get(f) or 0) for f in FIELDS}))

    cum = {}   # model -> (ts_list, prefix_sums_list)
    for model, evs in events.items():
        evs.sort(key=lambda x: x[0])
        ts, pref, acc = [], [], {f: 0 for f in FIELDS}
        for t, v in evs:
            for f in FIELDS:
                acc[f] += v[f]
            ts.append(t)
            pref.append(dict(acc))
        cum[model] = (ts, pref)

    filled = 0
    for row in rows:
        t = row.get("ts") or 0
        bt = {}
        for model, (ts, pref) in cum.items():
            i = bisect.bisect_right(ts, t)
            if i <= 0:
                continue
            bt[model] = pref[i - 1]
        if bt:
            row["by_model_tokens"] = bt
            filled += 1

    print("rows: %d | filled with by_model_tokens: %d | models: %d"
          % (len(rows), filled, len(cum)))
    if dry:
        print("dry run — nothing written")
        return
    history._write_all(rows)
    print("written to", config.HISTORY)


if __name__ == "__main__":
    main()
