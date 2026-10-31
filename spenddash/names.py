"""Persistent session names (human labels for opaque session ids).

## Connections
- IMPORTS FROM: config (SESSION_NAMES), json/os (stdlib)
- EXPORTS: load_names, save_name
- CALLED BY: server (/data read, POST /name write)
- CALLS: config.SESSION_NAMES
- CONTRACT: names file is a flat JSON dict {session_id: name}. save_name
  validates key/name length (ids <= 128 chars, names <= 200); empty name
  REMOVES the entry. Load tolerates missing/corrupt files (returns {}).
  Writes are atomic via tmp+os.replace, same as history.
"""
import json
import os

from . import config


def load_names():
    if not os.path.exists(config.SESSION_NAMES):
        return {}
    try:
        with open(config.SESSION_NAMES) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_name(session_id, name):
    name = (name or "").strip()
    if not session_id or len(session_id) > 128:
        return False
    if not name:
        names = load_names()
        names.pop(session_id, None)
    else:
        if len(name) > 200:
            name = name[:200]
        names = load_names()
        names[session_id] = name
    tmp = config.SESSION_NAMES + ".tmp"
    with open(tmp, "w") as f:
        json.dump(names, f, indent=1)
    os.replace(tmp, config.SESSION_NAMES)
    return True
