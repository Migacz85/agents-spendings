"""Agent catalog: who each connected agent is, what it runs, when it was last
active — everything the dashboard can read from its Hermes home.

## Connections
- IMPORTS FROM: config (STATE_DBS), json/os (stdlib)
- EXPORTS: build_catalog
- CALLED BY: snapshot
- CALLS: config.STATE_DBS; reads each agent home's SOUL.md and cron/jobs.json
- CONTRACT: given the already-tagged ledger records, returns one entry per
  agent (label, db, home) with:
    soul    — text under the SOUL.md "## Role" heading ("" when stock identity)
    crons   — jobs from <home>/cron/jobs.json: name, schedule display,
              enabled, state, prompt (truncated)
    records/cost/models/last — ledger aggregates
    latest  — most recently touched session {session, last, cost}
  All file reads are tolerant (missing/corrupt -> empty). Entries sorted by
  lifetime cost desc. Home is derived from the db path (dirname) — a mounted
  fleet home therefore works unchanged, and scan_dir discovery (config) needs
  no per-agent code here.
"""
import json
import os
import re

from . import config
from .ledger import _dollars, _micro


def _soul_role(home):
    p = os.path.join(home, "SOUL.md")
    if not os.path.exists(p):
        return ""
    try:
        txt = open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return ""
    idx = txt.lower().find("## role")
    if idx < 0:
        return ""
    end = txt.find("\n## ", idx + 8)
    sec = txt[idx + 8:end if end > 0 else None].strip()
    return sec[:1500]


def _crons(home):
    p = os.path.join(home, "cron", "jobs.json")
    if not os.path.exists(p):
        return []
    try:
        data = json.load(open(p, encoding="utf-8", errors="replace"))
    except Exception:
        return []
    out = []
    for j in (data.get("jobs") or []):
        sc = j.get("schedule") or {}
        out.append({
            "name": j.get("name") or j.get("id") or "unnamed",
            "id": j.get("id") or j.get("name") or "",
            "schedule": j.get("schedule_display") or sc.get("display") or "",
            "minutes": sc.get("minutes") if sc.get("kind") == "interval" else None,
            "enabled": bool(j.get("enabled")),
            "state": j.get("state") or "",
            "prompt": (j.get("prompt") or "")[:140],
        })
    out.sort(key=lambda x: x["name"])
    return out


def _read_prefix(home, rel, n=220):
    p = os.path.join(home, rel)
    if not os.path.exists(p):
        return None
    try:
        txt = open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return None
    return {"file": rel, "bytes": os.path.getsize(p), "excerpt": txt[:n].strip()}


def _def_files(home):
    """The files that determine what an agent IS and does: SOUL identity,
    memory (what it remembers about the world/user), etc. Order = importance."""
    out = []
    for rel in ("SOUL.md", "memories/MEMORY.md", "memories/USER.md"):
        item = _read_prefix(home, rel)
        if item:
            out.append(item)
    return out


def _skills(home):
    base = os.path.join(home, "skills")
    if not os.path.isdir(base):
        return []
    out = []
    for root, _dirs, files in os.walk(base):
        if "SKILL.md" in files:
            rel = os.path.relpath(root, base).replace(os.sep, "/")
            if rel == ".":
                rel = root.rsplit("/", 1)[-1]
            desc = ""
            try:
                txt = open(os.path.join(root, "SKILL.md"),
                           encoding="utf-8", errors="replace").read(800)
                m = re.search(r"^description:\s*(.+)$", txt, re.M)
                if m:
                    desc = m.group(1).strip().strip('"').strip("'")
            except Exception:
                pass
            out.append({"name": rel, "desc": desc})
    return sorted(out, key=lambda x: x["name"])


def _config_bits(home):
    p = os.path.join(home, "config.yaml")
    if not os.path.exists(p):
        return {}
    try:
        txt = open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return {}
    def first(pat):
        m = re.search(pat, txt, re.M)
        return m.group(1).strip().strip('"\'') if m else None
    model = first(r"^\s*default:\s*(.+)$")
    provider = first(r"^\s*provider:\s*(.+)$")
    return {"model": model, "provider": provider}


def build_catalog(records, agents=None):
    agents = agents or config.STATE_DBS
    out = []
    for db, label in agents:
        home = os.path.dirname(db)
        recs = [r for r in records if r["agent"] == label]
        last = max((r["last"] or 0) for r in recs) if recs else 0
        latest = None
        if recs:
            t = max(recs, key=lambda r: r["last"] or 0)
            latest = {"session": t["session"], "last": t["last"], "cost": t["cost"]}
        skills = _skills(home)
        out.append({
            "label": label,
            "db": db,
            "home": home,
            "soul": _soul_role(home),
            "def_files": _def_files(home),
            "skills": skills,
            "config": _config_bits(home),
            "crons": _crons(home),
            "records": len(recs),
            "cost": _dollars(sum(_micro(r["cost"]) for r in recs)),
            "last": last,
            "models": sorted({r["model"] for r in recs}, key=str.lower),
            "latest": latest,
        })
    out.sort(key=lambda x: -x["cost"])
    return out
