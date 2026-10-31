"""Central settings for the spend dashboard.

## Connections
- IMPORTS FROM: json/os (stdlib)
- EXPORTS: AGENTS_FILE, STATE_DBS, HISTORY, SESSION_NAMES, PORT,
  BUCKET_SECONDS, HISTORY_MAX_LINES, APP_DIR, load_agents
- CALLED BY: ledger, history, collector, server, cli, catalog
- CALLS: nothing
- CONTRACT: single source of truth for paths and sizing. STATE_DBS is a list
  of (state.db path, agent label) pairs resolved by load_agents():

    agents.json exists (gitignored — deployment config, edit freely):
      { "scan_dir": "/mnt/fleet",          # optional: auto-discover agents
        "agents": [ {"db": "/path/state.db", "label": "hermet"} ] }
      scan_dir: every subdir with .hermes/state.db (or state.db) becomes an
      agent labeled by the directory name — drop a fleet mount here and all
      containers appear automatically, no Python edits.

    no agents.json: defaults to this laptop's default profile ("laptop")
    and twin profile ("core2").

  Rename/relabel agents here (or in agents.json) — labels propagate to every
  table, chart, and the catalog.
"""

import json
import os

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_FILE = os.path.join(APP_DIR, "agents.json")
HISTORY = os.path.join(APP_DIR, "history.jsonl")
SESSION_NAMES = os.path.join(APP_DIR, "session_names.json")
LAST_KNOWN = os.path.join(APP_DIR, "last_known_agent_totals.json")   # carry-forward cache across restarts
PORT = int(os.environ.get("SDASH_PORT", "8399"))   # SDASH_PORT lets a dev instance run beside prod
BUCKET_SECONDS = 300          # collector + snapshot cadence
HISTORY_MAX_LINES = 6000      # capped history file (300s x 6000 -> ~3.5 weeks)


def load_agents():
    """Resolve (db_path, label) pairs: agents.json overrides, scan_dir adds
    auto-discovered containers, default falls back to laptop + core2."""
    entries = []
    if os.path.exists(AGENTS_FILE):
        try:
            with open(AGENTS_FILE) as f:
                data = json.load(f)
        except Exception:
            data = {}
        for a in (data.get("agents") or []):
            db, label = a.get("db"), a.get("label")
            if db and label:
                entries.append((db, label))
        scan = data.get("scan_dir")
        if scan and os.path.isdir(scan):
            known = {label for _, label in entries}
            for name in sorted(os.listdir(scan)):
                p = os.path.join(scan, name)
                if not os.path.isdir(p) or name.startswith("."):
                    continue
                db = os.path.join(p, ".hermes", "state.db")
                if not os.path.exists(db):
                    db = os.path.join(p, "state.db")
                if os.path.exists(db) and name not in known:
                    entries.append((db, name))
                    known.add(name)
    else:
        home = os.path.expanduser("~/.hermes")
        entries = [
            (os.path.join(home, "state.db"), "laptop"),
            (os.path.join(home, "profiles", "twin", "state.db"), "core2"),
        ]
    return entries


STATE_DBS = load_agents()


def save_agents(agents=None, scan_dir=None):
    """Persist agents.json (atomic). None keeps the current value; used by
    the CLI agent commands so fleet wiring never needs a git commit."""
    data = {}
    try:
        with open(AGENTS_FILE) as f:
            data = json.load(f)
    except Exception:
        if agents is None and scan_dir is None:
            return False        # nothing to save and nothing to merge into
    if agents is not None:
        data["agents"] = agents
    if scan_dir is not None:
        data["scan_dir"] = scan_dir
    tmp = AGENTS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, AGENTS_FILE)
    return True


def reload_agents():
    """Re-resolve STATE_DBS from disk. Called on every snapshot so agents
    added via agents.json appear WITHOUT a server restart."""
    global STATE_DBS
    STATE_DBS = load_agents()
