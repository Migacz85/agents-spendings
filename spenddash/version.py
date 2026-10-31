"""Build / environment identity for the dashboard (dev vs production).

## Connections
- IMPORTS FROM: config (APP_DIR), os (stdlib)
- EXPORTS: build_info
- CALLED BY: server (/data payload -> the UI header shows it)
- CALLS: config.APP_DIR
- CONTRACT: returns {"env": "dev"|"production"|..., "build": "<git-short-hash|VERSION>"}.
  env comes from SDASH_ENV (set to "production" by the systemd unit on Lyra);
  build from SDASH_BUILD, else the VERSION file written by scripts/deploy.sh,
  else "dev". Displayed in the header so you can always tell which build a page
  is serving — the same code runs in dev (laptop) and production (Lyra).
"""
import os

from . import config


def build_info():
    env = os.environ.get("SDASH_ENV", "dev")
    build = os.environ.get("SDASH_BUILD")
    if not build:
        vp = os.path.join(config.APP_DIR, "VERSION")
        try:
            with open(vp) as f:
                build = f.read().strip() or "dev"
        except OSError:
            build = "dev"
    return {"env": env, "build": build}
