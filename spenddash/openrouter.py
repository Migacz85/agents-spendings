"""OpenRouter credits endpoint — the authoritative real-money figure.

## Connections
- IMPORTS FROM: config (nothing), os/re/urllib/json (stdlib)
- EXPORTS: openrouter_balance
- CALLED BY: snapshot
- CALLS: GET https://openrouter.ai/api/v1/credits (Bearer key from ~/.hermes/.env)
- CONTRACT: returns {"total_credits", "total_usage", "balance"} where balance =
  credits - usage; any of the three may be None when the key is missing or the
  call fails (callers must tolerate Nones). The ledger estimate is NOT the
  bill — OpenRouter usage is.
"""
import json
import os
import re
import urllib.request

_ENV_FILE = os.path.expanduser("~/.hermes/.env")
_KEY_CACHE = None


def _openrouter_key():
    global _KEY_CACHE
    if _KEY_CACHE is not None:
        return _KEY_CACHE
    try:
        m = re.search(r"OPENROUTER_API_KEY=(\S+)", open(_ENV_FILE).read())
        _KEY_CACHE = m.group(1) if m else ""
    except Exception:
        _KEY_CACHE = ""
    return _KEY_CACHE


def openrouter_balance():
    out = {"total_credits": None, "total_usage": None, "balance": None}
    key = _openrouter_key()
    if not key:
        return out
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/credits",
            headers={"Authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode())["data"]
        out["total_credits"] = float(data.get("total_credits"))
        out["total_usage"] = float(data.get("total_usage"))
        if out["total_credits"] is not None and out["total_usage"] is not None:
            out["balance"] = out["total_credits"] - out["total_usage"]
    except Exception as e:
        print("  openrouter_balance error:", e)
    return out
