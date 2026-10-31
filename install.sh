#!/usr/bin/env bash
# Hermes Spend Dashboard installer.
#
#   ./install.sh [--dir /opt/agents-spendings] [--port 8399] [--systemd] [--user NAME]
#
# No pip dependencies: pure Python 3 stdlib + a vendored Chart.js.
# Idempotent: re-running upgrades the code and never touches history.jsonl.
set -euo pipefail

DIR=/opt/agents-spendings
PORT=8399
SYSTEMD=0
RUNUSER=$(id -un)

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     DIR=$2; shift 2 ;;
    --port)    PORT=$2; shift 2 ;;
    --user)    RUNUSER=$2; shift 2 ;;
    --systemd) SYSTEMD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "error: python3 is required" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)

echo "==> installing $SRC -> $DIR (port $PORT)"
# SAFETY: never wipe a directory that isn't clearly our install. --delete is
# only used when upgrading an existing install (spenddash/ present), so pointing
# --dir at a data folder can never delete unrelated files.
case "$DIR" in
  "/"|"$HOME"|"$HOME/"|"") echo "error: refusing to install into '$DIR'" >&2; exit 3 ;;
esac
UPGRADE=0
if [ -d "$DIR/spenddash" ]; then
  UPGRADE=1
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "error: $DIR exists and does not look like an existing install (no spenddash/);" >&2
  echo "       pick an empty/new directory. Nothing was changed." >&2
  exit 3
fi
mkdir -p "$DIR"
DEL=(); [ "$UPGRADE" = "1" ] && DEL=(--delete)
# keep a pre-existing local config even when the source tree ships one
HAD_CFG=0; [ -f "$DIR/agents.json" ] && HAD_CFG=1
if command -v rsync >/dev/null; then
  rsync -a "${DEL[@]}" \
    --exclude '.git' --exclude '__pycache__' \
    --exclude 'history.jsonl*' --exclude 'sync.log' \
    --exclude 'last_known_agent_totals.json' \
    --exclude 'agents.json' --exclude 'fleet/' --exclude 'session_names.json' \
    "$SRC"/ "$DIR"/
else
  cp -a "$SRC"/. "$DIR"/
  rm -rf "$DIR/.git" "$DIR"/__pycache__ "$DIR"/spenddash/__pycache__
  rm -f "$DIR/agents.json" "$DIR/session_names.json"
fi
[ "$HAD_CFG" = "1" ] || rm -f "$DIR/agents.json"

# agents.json: keep an existing one; otherwise discover Hermes state DBs locally
if [ ! -f "$DIR/agents.json" ]; then
  python3 - "$DIR" <<'PY'
import json, os, sys
dest = sys.argv[1]
home = os.path.expanduser("~/.hermes")
agents = []
if os.path.exists(os.path.join(home, "state.db")):
    agents.append({"label": "laptop", "db": os.path.join(home, "state.db")})
prof = os.path.join(home, "profiles")
if os.path.isdir(prof):
    for name in sorted(os.listdir(prof)):
        db = os.path.join(prof, name, "state.db")
        if os.path.exists(db):
            agents.append({"label": name, "db": db})
if not agents:
    agents = [{"label": "laptop", "db": os.path.join(home, "state.db")}]
cfg = {"agents": agents, "scan_dir": os.path.join(dest, "fleet")}
with open(os.path.join(dest, "agents.json"), "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print("==> wrote agents.json with %d agent(s)" % len(agents))
for a in agents:
    print("      %-12s %s" % (a["label"], a["db"]))
PY
else
  echo "==> keeping existing agents.json"
fi

chmod +x "$DIR/collect.py" 2>/dev/null || true

echo "==> test snapshot"
( cd "$DIR" && python3 collect.py --once >/dev/null ) || {
  echo "!! snapshot failed — check the state.db paths in $DIR/agents.json" >&2
  exit 1
}
echo "    ok ($(python3 -c "import json;d=json.load(open('$DIR/agents.json'));print(len(d.get('agents',[])))" 2>/dev/null || echo '?') agents configured)"

if [ "$SYSTEMD" = "1" ]; then
  [ "$(id -u)" = "0" ] || { echo "error: --systemd needs root" >&2; exit 1; }
  UNIT=/etc/systemd/system/agents-spendings.service
  cat > "$UNIT" <<EOF
[Unit]
Description=Hermes fleet spend dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUNUSER
WorkingDirectory=$DIR
Environment=SDASH_PORT=$PORT
ExecStart=/usr/bin/env python3 $DIR/collect.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now agents-spendings.service
  echo "==> service agents-spendings started on port $PORT"
else
  echo
  echo "Run it:"
  echo "  cd $DIR && SDASH_PORT=$PORT python3 collect.py"
  echo "  (re-run with --systemd as root to install a systemd unit)"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Dashboard:  http://${IP:-127.0.0.1}:$PORT/"
echo "Agent API:  http://${IP:-127.0.0.1}:$PORT/api     (see /llms.txt for a plain-text guide)"
echo "History:    $DIR/history.jsonl  (append-only, 5-min buckets)"
echo
echo "First load charts fill in as the collector ticks (one row per 5 minutes)."
