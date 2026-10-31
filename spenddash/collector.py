"""Background collector — snapshot + persist every BUCKET_SECONDS.

## Connections
- IMPORTS FROM: config (BUCKET_SECONDS), snapshot (collect_snapshot),
  history (append_history), time (stdlib)
- EXPORTS: run_collector
- CALLED BY: cli (default mode, via a daemon thread)
- CALLS: snapshot.collect_snapshot, history.append_history
- CONTRACT: infinite loop; each tick appends a snapshot for the current
  5-min bucket (append_history dedupes). Tolerates transient ledger/network
  errors (log and continue). Collector failures must NEVER kill the HTTP
  server — run on a daemon thread so process exit still serves.
"""
import time

from . import config, history, snapshot


def run_collector():
    while True:
        try:
            snap = snapshot.collect_snapshot()
            history.append_history(snap)
            b = snap["balance"]
            print(f"[{time.strftime('%H:%M:%S')}] ledger=${snap['ledger_total_cost']:.4f} "
                  f"balance=${b['balance']:.2f} used=${b['total_usage']:.2f} records={snap['records']}")
        except Exception as e:
            print("collect error:", e)
        # sleep to the NEXT bucket boundary, not a fixed 300s: a snapshot that
        # takes 10-15 s pushes a fixed sleep later every tick, which produced
        # the observed gaps (up to ~9 min) between history rows.
        try:
            now = time.time()
            nxt = (int(now // config.BUCKET_SECONDS) + 1) * config.BUCKET_SECONDS
            time.sleep(max(1.0, nxt - now))
        except Exception:
            time.sleep(config.BUCKET_SECONDS)
