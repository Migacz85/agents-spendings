# Connecting agents to the spend dashboard

**Repo rule: connection steps must not commit to the repo.** Every connection
step below changes ONLY `agents.json` (repo root, gitignored) or a directory
you mount — no commits, no new files in git. The dashboard hot-reloads
`agents.json` on every refresh, so changes apply within a few seconds with
NO restart.

The dashboard reads each agent's `state.db` SQLite file (owned by the agent,
with `session_model_usage` rows). To connect an agent you must make its
`state.db` **readable from the dashboard host** and register it. There are
exactly three ways — pick the one that fits how the agent's storage is
reachable.

---

## Fastest: point at a state.db you can already read

```bash
cd /path/to/agents-spendings
python3 collect.py --agent-add <label> /path/to/<agent>/.hermes/state.db
```

- `<label>` = short name that will appear in the dashboard, e.g. `hermet`
- works for any locally reachable file: same host, sshfs/FUSE mount, NFS,
  a `scp`-copied copy, a 9p/share mount from a VM…
- the command verifies the file exists, merges it into `agents.json`
  (keeps every other agent), and hot-reloads

Verify it landed (needs ~1 line from the API, agent appears in the table):

```bash
python3 collect.py --agents          # list + health (MISSING = bad path)
curl -s http://127.0.0.1:8399/data | python3 -c "import json,sys; d=json.load(sys.stdin); print([c['label'] for c in d['snapshot']['catalog']])"
```

Undo:  `python3 collect.py --agent-remove <label>`

## Mass discovery: scan_dir for a mounted fleet

If several agents' homes are reachable under ONE directory (each agent in its
own subdir with a `state.db` or `.hermes/state.db`), register the root once:

```bash
python3 collect.py --agent-scan /mnt/fleet
```

Every subdirectory containing a `state.db` becomes an agent **automatically**
(labelled by directory name). Drop new mounts in and they appear with no
further commands. Per-agent entries in `agents.json` take precedence over the
scan.

## Recommended for THIS fleet (per-container homes, no shared mount)

The dashboard already points at `fleet/` (repo root, gitignored) as its scan
directory — every subdir of `fleet/` holding a `state.db` is an agent, and
the expanded card reads the agent's `SOUL.md`, `memories/`, `cron/`,
`config.yaml` and `skills/` from the same subdir. So connecting = getting
those files pushed there.

The laptop has NO inbound SSH (by design), so nothing may push to it. The
sync therefore runs as a **laptop pull**: Hermet's scripts STAGE everything
locally on the lab host at `/root/dash-sync/fleet/`, and the laptop — which already
has the lab host access — pulls that dir into `fleet/` automatically.

- Everything is one command ON THE LAPTOP, run by cron every 30 min
  (script `scripts/pull-fleet.sh`):
  ```bash
  ./scripts/pull-fleet.sh
  ```
  it SSHes to the lab host → runs `/root/dash-scripts/run-dash-sync.sh` (which
  dumps every container's state.db + profile into staging, and fetches
  avatars with Hermet's tokens when `tokens.txt` exists) → rsyncs staging
  into `fleet/`.
- On the lab host (Hermet's side, only touch if you change the container map or
  tokens): `scripts/fleet-sync.sh` and `scripts/fetch-avatars.sh` — both
  stage to `/root/dash-sync/fleet/`; add a new agent by appending its
  container id to the `CT=()` maps.
- The dashboard hot-reloads `agents.json`; new/stale agents and avatars
  show within 30 min of a cron pull, seconds after a manual run.

One-off for a single agent: the `--agent-add` flow above still works.

## What the agent needs from the dashboard

- Dashboard URL: `http://<dashboard-host>:8399/` (data: `/data`, health: `/health`)
- A connected agent automatically gets: spend tables by agent/model/session,
  role + SOUL/memory/skills/crons/model in its expanded card, cron job
  management (delete/cadence/enable), model switching — all via the Agents
  page. The dashboard only READS `state.db`, crons and config.yaml; it never
  writes into an agent's own home except when the user explicitly edits
  SOUL/memory/model/crons from the UI (paths whitelisted to that agent home).
