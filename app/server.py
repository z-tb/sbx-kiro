"""sbx Manager HTTP server (stdlib only).

Binds to 127.0.0.1 only. Serves a single static UI from app/static and a
small set of JSON API endpoints. Routing is a {(method, path): handler}
dispatch table so adding a feature is: write a handler, register a row.

Run: python3 -m app.server
"""
from __future__ import annotations

import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlparse

from . import sbx
from .features import egress as egress_feature
from .features import secrets as secrets_feature

HOST = "127.0.0.1"
PORT = 8123
STATIC_DIR = Path(__file__).parent / "static"

# A handler receives the request handler instance and returns
# (status, headers, body_bytes).
Handler = Callable[["AppRequestHandler"], tuple[int, dict, bytes]]

# ---------------------------------------------------------------------------
# API handlers
# ---------------------------------------------------------------------------


def _json(status: int, payload) -> tuple[int, dict, bytes]:
    body = json.dumps(payload).encode("utf-8")
    return status, {"Content-Type": "application/json"}, body


def api_sandboxes(_req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """GET /api/sandboxes — list sandboxes from `sbx ls --json`."""
    if not sbx.sbx_available():
        return _json(503, {"error": "sbx CLI not found on PATH", "sandboxes": []})
    result, parsed = sbx.run_sbx_json(["ls", "--json"])
    if not result.ok:
        return _json(502, {"error": result.stderr.strip() or "sbx ls failed", "sandboxes": []})
    # `sbx ls --json` returns {"sandboxes": [...]}; accept a bare list too.
    if isinstance(parsed, dict):
        sandboxes = parsed.get("sandboxes", [])
    elif isinstance(parsed, list):
        sandboxes = parsed
    else:
        sandboxes = []
    return _json(200, {"sandboxes": sandboxes})


# -- secrets ---------------------------------------------------------------


def api_secrets_list(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """GET /api/secrets?scope=<name|__global__>&service=<svc>"""
    q = req.query()
    scope = q.get("scope")
    service = q.get("service")
    status, payload = secrets_feature.list_secrets(scope=scope, service=service)
    return _json(status, payload)


def api_secrets_set(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """POST /api/secrets — body: {service, value?|oauth?|ref?|command?, scope?, refresh?}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    service = body.get("service")
    if not service:
        return _json(400, {"error": "service is required"})
    status, payload = secrets_feature.set_secret(
        service,
        value=body.get("value"),
        scope=body.get("scope"),
        oauth=bool(body.get("oauth")),
        ref=body.get("ref"),
        command=body.get("command"),
        refresh=body.get("refresh"),
    )
    return _json(status, payload)


def api_secrets_remove(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """DELETE /api/secrets — body: {service, scope?}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    service = body.get("service")
    if not service:
        return _json(400, {"error": "service is required"})
    status, payload = secrets_feature.remove_secret(service, scope=body.get("scope"))
    return _json(status, payload)


# -- egress ----------------------------------------------------------------


def api_egress_list(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """GET /api/egress?scope=<name|__global__>"""
    scope = req.query().get("scope")
    status, payload = egress_feature.list_rules(scope=scope)
    return _json(status, payload)


def api_egress_allow(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """POST /api/egress/allow — body: {resources, scope?, protocol?}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    status, payload = egress_feature.allow(
        body.get("resources", ""),
        scope=body.get("scope"),
        protocol=body.get("protocol"),
    )
    return _json(status, payload)


def api_egress_deny(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """POST /api/egress/deny — body: {resources, scope?, protocol?}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    status, payload = egress_feature.deny(
        body.get("resources", ""),
        scope=body.get("scope"),
        protocol=body.get("protocol"),
    )
    return _json(status, payload)


def api_egress_check(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """POST /api/egress/check — body: {host, scope?}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    host = body.get("host", "")
    if not host:
        return _json(400, {"error": "host is required"})
    status, payload = egress_feature.check(host, scope=body.get("scope"))
    return _json(status, payload)


def api_egress_remove(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """DELETE /api/egress — body: {id}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    rule_id = body.get("id", "")
    if not rule_id:
        return _json(400, {"error": "id is required"})
    status, payload = egress_feature.remove(rule_id, scope=body.get("scope"))
    return _json(status, payload)


def api_egress_init(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """POST /api/egress/init — body: {mode}"""
    body = req.json_body()
    if body is None:
        return _json(400, {"error": "invalid JSON body"})
    status, payload = egress_feature.init(body.get("mode", ""))
    return _json(status, payload)


def api_egress_log(req: "AppRequestHandler") -> tuple[int, dict, bytes]:
    """GET /api/egress/log?scope=<name|__global__> — blocked/allowed activity."""
    scope = req.query().get("scope")
    status, payload = egress_feature.log(scope=scope)
    return _json(status, payload)


# ---------------------------------------------------------------------------
# Dispatch table — register (method, path) -> handler here.
# ---------------------------------------------------------------------------

ROUTES: dict[tuple[str, str], Handler] = {
    ("GET", "/api/sandboxes"): api_sandboxes,
    ("GET", "/api/secrets"): api_secrets_list,
    ("POST", "/api/secrets"): api_secrets_set,
    ("DELETE", "/api/secrets"): api_secrets_remove,
    ("GET", "/api/egress"): api_egress_list,
    ("POST", "/api/egress/allow"): api_egress_allow,
    ("POST", "/api/egress/deny"): api_egress_deny,
    ("POST", "/api/egress/check"): api_egress_check,
    ("DELETE", "/api/egress"): api_egress_remove,
    ("POST", "/api/egress/init"): api_egress_init,
    ("GET", "/api/egress/log"): api_egress_log,
}


class AppRequestHandler(BaseHTTPRequestHandler):
    server_version = "sbxManager/0.1"

    # -- helpers -----------------------------------------------------------
    def query(self) -> dict:
        """Return single-value query params from the request path."""
        raw = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in raw.items()}

    def json_body(self):
        """Parse a JSON request body. Returns None on invalid/missing JSON.

        Never logs the body — it may carry secret values.
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _send(self, status: int, headers: dict, body: bytes) -> None:
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _dispatch(self) -> None:
        path = urlparse(self.path).path
        handler = ROUTES.get((self.command, path))
        if handler is not None:
            try:
                status, headers, body = handler(self)
            except Exception as exc:  # surface as 500, never leak a traceback body
                self.log_error("handler error: %s", exc)
                status, headers, body = _json(500, {"error": "internal error"})
            self._send(status, headers, body)
            return
        # Fall back to static file serving for GET/HEAD.
        if self.command in ("GET", "HEAD"):
            self._serve_static(path)
            return
        self._send(405, {"Content-Type": "text/plain"}, b"method not allowed\n")

    def _serve_static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        # Prevent path traversal outside STATIC_DIR.
        if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
            self._send(403, {"Content-Type": "text/plain"}, b"forbidden\n")
            return
        if not target.is_file():
            self._send(404, {"Content-Type": "text/plain"}, b"not found\n")
            return
        ctype, _ = mimetypes.guess_type(str(target))
        body = target.read_bytes()
        self._send(200, {"Content-Type": ctype or "application/octet-stream"}, body)

    # -- verb entry points -------------------------------------------------
    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def log_message(self, fmt: str, *args) -> None:
        # Keep logs terse; never log request bodies (may carry secrets).
        super().log_message(fmt, *args)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AppRequestHandler)
    print(f"sbx Manager listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
