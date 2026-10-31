"""Cron job operations: delete a job or change its cadence in an agent's
cron/jobs.json.

## Connections
- IMPORTS FROM: config (STATE_DBS), json/os/datetime (stdlib)
- EXPORTS: CRON_CADENCES, allowed, delete_job, update_schedule
- CALLED BY: server (POST /cron/delete, POST /cron/update)
- CALLS: config.STATE_DBS; reads/writes <agent home>/cron/jobs.json
- CONTRACT: label must resolve to a connected agent (STATE_DBS) — never an
  arbitrary path. The job id must exist in that agent's jobs file. Schedule
  changes write kind=interval cadences (Hermes' supported interval shape):
  schedule = {kind:"interval", minutes:N, display:"every <label>"} and
  schedule_display. EVERYTHING ELSE in jobs.json is preserved byte-for-byte
  (the file is json-loaded, the one job edited, dumped back). Writes are
  atomic via tmp+os.replace. Returns False (no crash) on any validation
  failure. Note: Hermes' scheduler picks the file up on its next tick.
"""

import json
import os
from datetime import datetime, timezone

from . import config

# cadence options: minutes -> label (matches the dashboard timeframe ladder
# where it makes sense for schedules)
CRON_CADENCES = [
    (1, "1m"), (5, "5m"), (15, "15m"), (30, "30m"),
    (60, "1h"), (360, "6h"), (720, "12h"), (1440, "24h"),
]

def _allowed_labels():
    return {label for _db, label in config.STATE_DBS}


def _jobs_path(label):
    for db, lab in config.STATE_DBS:
        if lab == label:
            return os.path.join(os.path.dirname(db), "cron", "jobs.json")
    return None


def _load_jobs(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return json.load(f)
    except Exception:
        return None


def _save_jobs(path, data):
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def _find_job(data, job_id):
    for j in data.get("jobs", []):
        if j.get("id") == job_id or j.get("name") == job_id:
            return j
    return None


def set_enabled(label, job_id, enabled):
    if label not in _allowed_labels() or not job_id:
        return False
    path = _jobs_path(label)
    data = _load_jobs(path)
    if not isinstance(data, dict):
        return False
    job = _find_job(data, job_id)
    if not job:
        return False
    job["enabled"] = bool(enabled)
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    return _save_jobs(path, data)


def delete_job(label, job_id):
    if label not in _allowed_labels() or not job_id:
        return False
    path = _jobs_path(label)
    data = _load_jobs(path)
    if not isinstance(data, dict) or not _find_job(data, job_id):
        return False
    data["jobs"] = [j for j in data.get("jobs", []) if j.get("id") != job_id
                    and j.get("name") != job_id]
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    return _save_jobs(path, data)


def update_schedule(label, job_id, minutes):
    if label not in _allowed_labels():
        return False
    minutes = int(minutes) if str(minutes).isdigit() else -1
    entry = next((c for c in CRON_CADENCES if c[0] == minutes), None)
    if not entry or not job_id:
        return False
    path = _jobs_path(label)
    data = _load_jobs(path)
    job = _find_job(data, job_id) if data else None
    if not job:
        return False
    label_min = entry[1]
    job["schedule"] = {"kind": "interval", "minutes": minutes,
                       "display": f"every {label_min}"}
    job["schedule_display"] = f"every {label_min}"
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    return _save_jobs(path, data)
