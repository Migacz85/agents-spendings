# Spend dashboard — agent API

Read-only JSON so agents (or scripts) can pull the fleet's spend numbers without
parsing the UI. All money values are **USD floats**; `window` is in **minutes**
(default `480` = 8h, `window=0` = all history).

Base: `http://HOST:8399` (LAN only)

| endpoint | what |
|---|---|
| `GET /api` | index: endpoints, notes, default window — start here |
| `GET /api/summary?window=480` | one-shot: balance, spend for the window/today, runway, per-agent + per-model lifetime |
| `GET /api/agents?window=480` | per-agent `spent_window`, `lifetime`, `last_seen_minutes_ago`, `active` |
| `GET /api/models?window=480` | per-model `spent_window`, `lifetime`, `share_pct`, and window `calls` / `in` / `out` / `cache` / `reasoning` tokens |
| `GET /data` | the full raw payload (snapshot + all history rows) — heavy (~700 KB), use only when you need raw history |
| `GET /health` | `{"status":"ok"}` |

## Reading the numbers honestly

- `spent.source = "paid"` → the figure is the **real drop** in the OpenRouter
  account balance (what was actually charged). This is the trustworthy one.
- `spent.source = "ledger"` → the balance API hadn't moved yet (it lags), so the
  figure is the agents' own cost **estimate** (priced from the model list price).
- Per-agent and per-model splits are always ledger estimates — provider billing
  is account-wide, so per-agent money cannot come from the balance.
- `calibration.factor` (in `/api/summary`) is the ratio the UI multiplies those
  estimates by to reconcile them with paid spend. API values stay **raw**; apply
  the factor yourself if you want numbers that match the dashboard's calibrated view.
- `covered_minutes` says how far back the window's data actually reaches (a
  fresh window shorter than requested is normal after a restart or fleet change).

## Examples

```bash
curl -s http://HOST:8399/api | jq .
curl -s 'http://HOST:8399/api/summary' | jq '{balance, spent, runway}'
curl -s 'http://HOST:8399/api/agents?window=60' | jq '.agents[:3]'
curl -s 'http://HOST:8399/api/models?window=1440' | jq '.models[:5]'
```
