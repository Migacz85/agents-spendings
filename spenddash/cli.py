"""CLI entry orchestration: --once | --serve | default (collect+serve).

## Connections
- IMPORTS FROM: config (APP_DIR), snapshot (collect_snapshot), history
  (append_history), collector (run_collector), server (serve), stdlib
- EXPORTS: main
- CALLED BY: collect.py (the only entry point)
- CALLS: snapshot.collect_snapshot, history.append_history,
  collector.run_collector, server.serve
- CONTRACT:
    python3 collect.py --once   one snapshot, persist, print, exit
    python3 collect.py --serve  serve only (no background collector)
    python3 collect.py          collector daemon thread + serve
  chdirs to the app dir so static assets resolve; does NOT touch any other
  module's internals.
"""
import json
import os
import sys
import threading

from . import config, history, server, snapshot


def _list_agents():
    print(f"{'agent':16s} {'ok':4s} state.db")
    for db, label in config.STATE_DBS:
        ok = "yes" if os.path.exists(db) else "MISSING"
        print(f"{label:16s} {ok:4s} {db}")
    if os.path.exists(config.AGENTS_FILE):
        print(f"\nconfig: {config.AGENTS_FILE}")


def _add_agent(args):
    label, db = args[0], args[1] if len(args) > 1 else ""
    if not label or not db:
        print("usage: python3 collect.py --agent-add <label> <state.db path>")
        return 1
    if not os.path.exists(db):
        print(f"error: no state.db at {db}")
        return 1
    # base on the current agents.json; FIRST creation seeds the current
    # defaults (laptop/core2) so existing agents are never dropped
    try:
        with open(config.AGENTS_FILE) as f:
            data = json.load(f)
        entries = [dict(a) for a in data.get("agents", [])]
    except Exception:
        entries = [{"label": lab, "db": db} for db, lab in config.load_agents()]
    entries = [a for a in entries if a.get("label") != label]
    entries.append({"label": label, "db": db})
    if config.save_agents(agents=entries):
        config.reload_agents()
        print(f"added {label} -> {db} (hot-reloaded, no restart needed)")
        return 0
    return 1


def _remove_agent(args):
    label = args[0] if args else ""
    if not label:
        print("usage: python3 collect.py --agent-remove <label>")
        return 1
    try:
        with open(config.AGENTS_FILE) as f:
            data = json.load(f)
    except Exception:
        print("no agents.json — nothing to remove")
        return 1
    before = len(data.get("agents", []))
    data["agents"] = [a for a in data.get("agents", []) if a.get("label") != label]
    if len(data["agents"]) == before:
        print(f"no agent named {label}")
        return 1
    config.save_agents(agents=data["agents"], scan_dir=data.get("scan_dir"))
    config.reload_agents()
    print(f"removed {label}")
    return 0


def _scan_agents(args):
    d = args[0] if args else ""
    if not d:
        print("usage: python3 collect.py --agent-scan <dir>")
        return 1
    if not os.path.isdir(d):
        print(f"error: no such directory {d}")
        return 1
    config.save_agents(scan_dir=d)
    config.reload_agents()
    print(f"scan_dir now: {d} — every subdir with a state.db shows up automatically")
    _list_agents()
    return 0


def main():
    os.chdir(config.APP_DIR)
    if "--agents" in sys.argv:
        return _list_agents()
    if "--compact-history" in sys.argv:
        before = os.path.getsize(config.HISTORY) if os.path.exists(config.HISTORY) else 0
        n = history.compact_history()
        after = os.path.getsize(config.HISTORY) if os.path.exists(config.HISTORY) else 0
        print(f"history compacted: {n} rows, {before/1e6:.1f} MB -> {after/1e6:.1f} MB")
        return 0
    for flag, fn in (("--agent-add", _add_agent), ("--agent-remove", _remove_agent),
                     ("--agent-scan", _scan_agents)):
        if flag in sys.argv:
            i = sys.argv.index(flag)
            return fn(sys.argv[i+1:])
    if "--once" in sys.argv:
        snap = snapshot.collect_snapshot()
        history.append_history(snap)
        print(json.dumps(snap, indent=2)[:5000])
        return 0
    if "--serve" not in sys.argv:
        # collector thread collects IMMEDIATELY (its loop snapshots first, then
        # sleeps to the next bucket). We deliberately do NOT do a synchronous
        # initial snapshot here: that blocked the socket bind for ~15 s, so
        # every restart meant a visible outage. Bind first, collect in the
        # background — /data shows "collecting…" for the first seconds.
        from .collector import run_collector
        threading.Thread(target=run_collector, daemon=True).start()
    server.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
