"""History.jsonl persistence — the monotonically growing snapshot ledger.

## Connections
- IMPORTS FROM: config (HISTORY, HISTORY_MAX_LINES), json/os (stdlib)
- EXPORTS: load_history, append_history, compact_history, HISTORY_FIELDS
- CALLED BY: collector (append), server (/data load), cli, scripts/compact
- CALLS: config.HISTORY
- CONTRACT: one JSON object per line, keyed/deduped by "bucket" (the 5-min
  bucket epoch). ONLY the small aggregate fields are persisted (HISTORY_FIELDS)
  — the heavy per-snapshot detail (sessions, catalog, model_details) is NOT
  written: it made rows ~350 KB (~100 MB/day) and /data serves it fresh anyway.
  append_history is O(1) (plain append; replaces a same-bucket row; compacts at
  the cap). load_history is cached by (mtime,size) so repeated /data calls do
  not re-parse the file. These rows are the ONLY source the frontend trusts for
  per-window spend and balance-history spend.
"""
import json
import os

from . import config

# the ONLY fields a history row needs: everything the frontend derives windows,
# burn rates, balance-spend and revisions from. NOTHING heavy.
HISTORY_FIELDS = ("ts", "bucket", "host", "ledger_total_cost", "balance",
                  "openrouter_total_usage", "agents", "unreachable", "cum_rev",
                  "by_agent", "by_model", "by_task", "by_model_tokens", "records")

_cache: dict = {"mtime": None, "size": None, "lines": None}


def _slim(snap):
    """Keep only the small fields; drop sessions/catalog/model_details."""
    return {k: snap[k] for k in HISTORY_FIELDS if k in snap}


def _read_all():
    lines = []
    if os.path.exists(config.HISTORY):
        with open(config.HISTORY) as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    lines.append(_slim(json.loads(ln)))   # strips legacy bloat too
                except Exception:
                    pass
    return lines


def load_history():
    """Parsed history rows, cached until the file changes (mtime+size)."""
    try:
        st = os.stat(config.HISTORY)
    except OSError:
        return []
    if (_cache["lines"] is not None and _cache["mtime"] == st.st_mtime
            and _cache["size"] == st.st_size):
        return _cache["lines"]
    lines = _read_all()
    _cache.update(mtime=st.st_mtime, size=st.st_size, lines=lines)
    return lines


def _write_all(lines):
    tmp = config.HISTORY + ".tmp"
    with open(tmp, "w") as f:
        for l in lines:
            f.write(json.dumps(l) + "\n")
    os.replace(tmp, config.HISTORY)
    st = os.stat(config.HISTORY)
    _cache.update(mtime=st.st_mtime, size=st.st_size, lines=list(lines))


def compact_history():
    """Rewrite the file slimmed, deduped by bucket (last wins), capped."""
    lines = _read_all()
    seen, out = set(), []
    for l in lines:
        b = l.get("bucket")
        if b in seen:                     # replace earlier row of same bucket
            out = [x for x in out if x.get("bucket") != b]
        seen.add(b)
        out.append(l)
    if len(out) > config.HISTORY_MAX_LINES:
        out = out[-config.HISTORY_MAX_LINES:]
    _write_all(out)
    return len(out)


def append_history(snap):
    """Append one snapshot (O(1)); replace an existing same-bucket row."""
    slim = _slim(snap)
    lines = load_history()
    if any(l.get("bucket") == slim["bucket"] for l in lines):
        lines = [l for l in lines if l.get("bucket") != slim["bucket"]] + [slim]
        _write_all(lines)
        return len(lines)
    with open(config.HISTORY, "a") as f:
        f.write(json.dumps(slim) + "\n")
    lines = lines + [slim]
    if len(lines) > config.HISTORY_MAX_LINES:
        _write_all(lines[-config.HISTORY_MAX_LINES:])
        return config.HISTORY_MAX_LINES
    st = os.stat(config.HISTORY)
    _cache.update(mtime=st.st_mtime, size=st.st_size, lines=lines)
    return len(lines)
