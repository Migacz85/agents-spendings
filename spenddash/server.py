"""Static file + JSON API server for the dashboard.

## Connections
- IMPORTS FROM: config (PORT), snapshot (collect_snapshot), history
  (load_history), stdlib http/os
- EXPORTS: serve
- CALLED BY: cli
- CALLS: snapshot.collect_snapshot, history.load_history
- CONTRACT: serves the project dir's static files (/, /index.html, css, js)
  plus two JSON routes:
    /data   -> {"snapshot": <collect_snapshot()>, "history": <history lines>}
    /health -> {"status":"ok"}
  Errors become plain-text 500s. Server runs in the current working dir —
  cli chdirs to the app dir before calling serve.
"""
import hashlib
import json
import os
import re
import struct
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import config, cronops, files, history, names, snapshot, version, api

# ---- snapshot cache -------------------------------------------------------
# collect_snapshot() reads 10 SQLite DBs + calls the OpenRouter API (~11-15 s).
# /data used to do that on EVERY request, so loading the page took that long.
# Cache it briefly; the collector refreshes history on its own cadence anyway.
_SNAP = {"ts": 0.0, "snap": None}
SNAP_TTL = float(os.environ.get("SDASH_SNAP_TTL", "20"))


def cached_snapshot():
    import time
    now = time.time()
    if _SNAP["snap"] is None or (now - _SNAP["ts"]) > SNAP_TTL:
        _SNAP["snap"] = snapshot.collect_snapshot()
        _SNAP["ts"] = now
    return _SNAP["snap"]

_AV_PALETTE = [(79,140,255),(242,166,90),(116,209,161),(232,106,106),(167,139,250),
               (90,180,196),(230,193,122),(139,147,163),(63,185,159),(240,116,150)]

def _placeholder_avatar(seed):
    """Solid-color 64x64 PNG disc, color stable per agent label. Shown until
    Hermet syncs a real Telegram profile photo into fleet/<label>/avatar.*."""
    w = h = 64
    hx = int(hashlib.md5(seed.encode()).hexdigest(), 16)
    r, g, b = _AV_PALETTE[hx % len(_AV_PALETTE)]
    raw = b"".join(b"\x00" + bytes([r, g, b, y]) for y in range(h) for x in range(w))
    def c(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n"
            + c(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + c(b"IDAT", zlib.compress(raw))
            + c(b"IEND", b""))


class Handler(SimpleHTTPRequestHandler):
    def do_HEAD(self):
        # HEAD must advertise the same headers as GET (Link: …/api), so route it
        # through do_GET and just suppress the body
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def do_GET(self):
        try:
            if self.path in ("/", "/index.html"):
                # advertise the machine API on the HTML response itself, so an
                # agent that only does `curl -I` can discover it
                self._serve_file("index.html", "text/html", extra={
                    "Link": '</api>; rel="alternate"; type="application/json", '
                            '</llms.txt>; rel="llms"; type="text/plain"'})
            elif self.path == "/llms.txt":
                snap = cached_snapshot()
                rows = history.load_history()
                s = api.summary(snap, rows)
                bal = s["balance"]["balance"]
                sp = s["spent"]
                txt = (
                    "# Hermes fleet spend dashboard — read-only API for agents\n\n"
                    "Base: http://%s:%s\n\n"
                    "Endpoints\n"
                    "  GET /api                index: endpoints + notes (start here)\n"
                    "  GET /api/summary        balance, spend (window + today), runway, per-agent, per-model  [&window=MINUTES]\n"
                    "  GET /api/agents         per-agent spend for the window + lifetime  [&window=MINUTES]\n"
                    "  GET /api/models         per-model spend/tokens for the window + lifetime  [&window=MINUTES]\n"
                    "  GET /data               full raw snapshot + every history row (heavy, ~1 MB)\n"
                    "  GET /health             liveness\n\n"
                    "Rules\n"
                    "  window  = minutes (default 480 = 8h; 0 = all history)\n"
                    "  money   = USD floats\n"
                    "  spent.source = 'paid'   -> real OpenRouter balance drop (trustworthy)\n"
                    "                 'ledger' -> agents' cost estimates (balance API lags)\n"
                    "  per-agent/per-model values are RAW estimates; multiply by\n"
                    "  calibration.factor from /api/summary to match the dashboard view\n\n"
                    "Right now: balance $%s | spent in %.0f min: $%s (%s) | today $%s | runway ~%s h\n"
                    % (self.headers.get("Host", "localhost:8399").split(":")[0],
                       config.PORT,
                       ("%.2f" % bal) if bal is not None else "?",
                       s["window_minutes"],
                       ("%.2f" % sp["window"]) if sp["window"] is not None else "?",
                       sp["source"] or "?",
                       ("%.2f" % sp["today"]) if sp["today"] is not None else "?",
                       s["runway"]["hours"] if s["runway"]["hours"] is not None else "?")
                )
                self._resp(200, "text/plain; charset=utf-8", txt.encode())
            elif self.path == "/data":
                body = json.dumps({"snapshot": cached_snapshot(),
                                   "history": history.load_history(),
                                   "names": names.load_names(),
                                   "build": version.build_info()}).encode()
                self._resp(200, "application/json", body)
            elif self.path.startswith("/avatar"):
                u = urlparse(self.path)
                q = parse_qs(u.query)
                label = (q.get("label") or [""])[0]
                if not label or "/" in label or ".." in label:
                    self._resp(404, "image/png", b"")
                else:
                    served = False
                    for ext, ctype in (("png", "image/png"), ("jpg", "image/jpeg"),
                                       ("jpeg", "image/jpeg"), ("webp", "image/webp")):
                        p = os.path.join(config.APP_DIR, "fleet", label, "avatar." + ext)
                        if os.path.exists(p):
                            with open(p, "rb") as f:
                                self._resp(200, ctype, f.read())
                            served = True
                            break
                    if not served:
                        self._resp(200, "image/png", _placeholder_avatar(label))
            elif self.path.startswith("/file"):
                u = urlparse(self.path)
                q = parse_qs(u.query)
                content = files.read_file((q.get("label") or [""])[0],
                                          (q.get("rel") or [""])[0])
                if content is None:
                    self._resp(404, "application/json", b'{"ok": false}')
                else:
                    self._resp(200, "application/json",
                               json.dumps({"ok": True, "content": content}).encode())
            elif self.path == "/health":
                self._resp(200, "application/json", b'{"status":"ok"}')
            elif urlparse(self.path).path in ("/api", "/api/", "/api/summary", "/api/agents", "/api/models"):
                u = urlparse(self.path)
                q = parse_qs(u.query)
                win = None
                if "window" in q:
                    try:
                        win = max(0, int(float(q["window"][0])))
                    except (TypeError, ValueError):
                        win = None
                snap = cached_snapshot()
                rows = history.load_history()
                path = u.path.rstrip("/") or "/api"
                if path == "/api":
                    body = api.index(rows, snap)
                elif path == "/api/agents":
                    body = api.agents(snap, rows, win if win is not None else api.DEFAULT_WIN)
                elif path == "/api/models":
                    body = api.models(snap, rows, win if win is not None else api.DEFAULT_WIN)
                else:
                    body = api.summary(snap, rows, win)
                self._resp(200, "application/json", json.dumps(body).encode())
            else:
                super().do_GET()
        except Exception as e:
            try:
                self._resp(500, "text/plain", str(e).encode())
            except Exception:
                pass

    def do_POST(self):
        try:
            # optional hardening: if SDASH_TOKEN is set (e.g. in the unit file),
            # every write (names/cron/files/model) must carry the same token.
            # Off by default so the LAN-only homelab flow keeps working.
            want = os.environ.get("SDASH_TOKEN")
            if want and self.headers.get("X-SDASH-Token") != want:
                self._resp(401, "application/json", b'{"ok": false, "error": "unauthorized"}')
                return
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0)
            try:
                data = json.loads(body.decode() or "{}")
            except Exception:
                self._resp(400, "application/json", b'{"ok": false, "error": "bad json"}')
                return
            if self.path == "/name":
                ok = names.save_name(data.get("session", ""), data.get("name", ""))
                self._resp(200, "application/json", json.dumps({"ok": ok}).encode())
            elif self.path == "/cron/delete":
                ok = cronops.delete_job(data.get("label", ""), data.get("job_id", ""))
                self._resp(200, "application/json", json.dumps({"ok": ok}).encode())
            elif self.path == "/cron/update":
                ok = cronops.update_schedule(data.get("label", ""),
                                             data.get("job_id", ""),
                                             data.get("minutes", 0))
                self._resp(200, "application/json", json.dumps({"ok": ok}).encode())
            elif self.path == "/cron/enable":
                ok = cronops.set_enabled(data.get("label", ""),
                                         data.get("job_id", ""),
                                         data.get("enabled", False))
                self._resp(200, "application/json", json.dumps({"ok": ok}).encode())
            elif self.path == "/file/save":
                ok = files.save_file(data.get("label", ""),
                                     data.get("rel", ""),
                                     data.get("content", ""))
                self._resp(200, "application/json", json.dumps({"ok": ok}).encode())
            elif self.path == "/model":
                ok = files.set_model(data.get("label", ""),
                                     data.get("model", ""))
                self._resp(200, "application/json", json.dumps({"ok": ok}).encode())
            else:
                self.send_error(404)
        except Exception as e:
            try:
                self._resp(500, "text/plain", str(e).encode())
            except Exception:
                pass

    def _resp(self, code, ctype, body, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")  # live data + dev edits: never serve stale assets
        self._cc_set = True
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    def end_headers(self):
        # Static files (js/css/html) go through SimpleHTTPRequestHandler, which
        # sends no Cache-Control -> browsers may heuristically cache modules, so
        # an edited app.js/tables.js silently shows OLD behaviour. Force no-store
        # on every response that hasn't set it already.
        if not getattr(self, "_cc_set", False):
            self.send_header("Cache-Control", "no-store")
            self._cc_set = True
        super().end_headers()

    def _serve_file(self, name, ctype, extra=None):
        p = os.path.join(os.getcwd(), name)
        try:
            with open(p, "rb") as f:
                body = f.read()
        except Exception:
            self.send_error(404)
            return
        self._resp(200, ctype, body, extra)


def serve():
    host = os.environ.get("DASH_HOST", "0.0.0.0")  # LAN + loopback; set DASH_HOST=127.0.0.1 for loopback-only
    print(f"Serving spend dashboard on http://{host}:{config.PORT}/")
    ThreadingHTTPServer((host, config.PORT), Handler).serve_forever()
