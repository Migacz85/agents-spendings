"""Read/write selected agent definition files and change an agent's model.

## Connections
- IMPORTS FROM: config (STATE_DBS), os/re (stdlib)
- EXPORTS: DEF_FILES, read_file, save_file, set_model
- CALLED BY: server (GET /file, POST /file/save, POST /model)
- CALLS: config.STATE_DBS; reads/writes files under <agent home>/
- CONTRACT: label must resolve to a connected agent. Paths are whitelisted
  (SOUL.md, memories/MEMORY.md, memories/USER.md) — no traversal, no
  arbitrary path writes. config.yaml is NOT freeform-editable; model changes
  go through set_model which patches ONLY the value line inside the model
  block (default/model key), keeping every other byte intact; returns False
  if the block/value can't be found (never guesses structure). Model slugs
  are validated to a safe charset (no quotes/newlines/control chars). All
  writes are atomic via tmp+os.replace; UTF-8.
"""

import os
import re

from . import config

# freeform-editable definition files (relative to agent home)
DEF_FILES = ("SOUL.md", "memories/MEMORY.md", "memories/USER.md")

_SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_.:-]{1,120}$")


def _home(label):
    for db, lab in config.STATE_DBS:
        if lab == label:
            return os.path.dirname(db)
    return None


def read_file(label, rel):
    if rel not in DEF_FILES:
        return None
    home = _home(label)
    if not home:
        return None
    try:
        with open(os.path.join(home, rel), encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def save_file(label, rel, content):
    if rel not in DEF_FILES or not isinstance(content, str):
        return False
    home = _home(label)
    if not home:
        return False
    path = os.path.join(home, rel)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def _model_block(txt):
    """Find the model block and the value line to patch.

    Returns (block_start_index, value_line_index) or None. The block starts
    at a line matching ^model: (top-level) and ends at the next top-level
    key or EOF. Inside it, the FIRST `default:` (or `model:`) value line is
    the patch target (covers 'default: "x"', 'default: x', 'model: x').
    """
    lines = txt.split("\n")
    start = None
    end = len(lines)
    for i, ln in enumerate(lines):
        if not ln.strip():
            continue
        if ln[0] in " \t":
            continue
        if re.match(r"^model\s*:", ln):
            if start is None:
                start = i
            continue
        if start is not None:  # next top-level key ends the block
            end = i
            break
    if start is None:
        return None
    val = None
    for i in range(start + 1, end):
        m = re.match(r"^\s*(?:default|model)\s*:\s*.+", lines[i])
        if m:
            val = i
            break
    return (start, val)


def set_model(label, model):
    if label not in {lab for _db, lab in config.STATE_DBS}:
        return False
    if not isinstance(model, str) or not _SAFE_MODEL.match(model):
        return False
    home = _home(label)
    if not home:
        return False
    path = os.path.join(home, "config.yaml")
    try:
        with open(path, encoding="utf-8") as f:
            txt = f.read()
    except Exception:
        return False
    hit = _model_block(txt)
    if not hit or hit[1] is None:
        return False
    start, val = hit
    if start is None or val is None:
        return False
    lines = txt.split("\n")
    lines[val] = re.sub(
        r"^(\s*(?:default|model)\s*:\s*).*$",
        lambda m: m.group(1) + model,
        lines[val],
    )
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        os.replace(tmp, path)
        return True
    except Exception:
        return False
