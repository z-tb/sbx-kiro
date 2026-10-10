"""Secrets feature — maps UI actions to `sbx secret ...` commands.

Design:
- Pure functions that build argv + optional stdin and return (status, payload),
  so they can be unit-tested without HTTP.
- Secret values are ALWAYS delivered over stdin, never as argv (`--token` /
  `--value` are deliberately not used).
- Stored values are never returned to the client — only names/scope/metadata
  from `sbx secret ls --json`.
"""
from __future__ import annotations

from .. import sbx

# Documented service list (from sbx.md `secret set` / `import`).
SERVICES = [
    "anthropic", "copilot", "cursor", "devin", "droid", "github", "google",
    "groq", "mistral", "nebius", "openai", "openrouter", "xai",
]

# Scope sentinel used by the UI/API for the global scope.
GLOBAL = "__global__"


def _scope_args(scope: str | None) -> list[str]:
    """Translate a UI scope into sbx flags.

    - None  -> no scope flag (all scopes, used for listing)
    - GLOBAL -> global is the sbx default; no flag needed
    - "<name>" -> --sandbox <name>
    """
    if scope in (None, GLOBAL):
        return []
    return ["--sandbox", scope]


def list_secrets(scope: str | None = None, service: str | None = None):
    """GET: list secrets. scope None = all; GLOBAL = global only; else sandbox.

    Returns (status, payload). Values are never included — sbx doesn't expose
    them and we don't synthesize anything derived from them.
    """
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH", "secrets": []}

    args = ["secret", "ls", "--json"]
    if scope == GLOBAL:
        args.append("--global")
    elif scope is not None:
        args += ["--sandbox", scope]
    if service:
        args += ["--service", service]

    result, parsed = sbx.run_sbx_json(args)
    if not result.ok:
        return 502, {"error": result.stderr.strip() or "sbx secret ls failed", "secrets": []}
    # `sbx secret ls --json` returns an object:
    #   {"secrets": [...], "custom_secrets": [...], "shadowed_services": [...], ...}
    # Each secret: {"scope": "global"|<sandbox>, "type": "service", "name": ..., "secret": "(stored)"}.
    # Values are never present (only the "(stored)" placeholder). Accept a bare
    # list too, for forward-compat.
    if isinstance(parsed, dict):
        secrets = parsed.get("secrets", []) or []
        custom = parsed.get("custom_secrets", []) or []
    elif isinstance(parsed, list):
        secrets, custom = parsed, []
    else:
        secrets, custom = [], []
    return 200, {"secrets": secrets, "custom_secrets": custom}


def set_secret(
    service: str,
    *,
    value: str | None = None,
    scope: str | None = None,
    oauth: bool = False,
    ref: str | None = None,
    command: str | None = None,
    refresh: str | None = None,
):
    """POST: create/update a service secret.

    Exactly one source is used, in priority order:
    - oauth:   `sbx secret set <service> --oauth` (no stdin)
    - ref:     `sbx secret set <service> --ref <REF>` (dynamic source, no stdin)
    - command: `sbx secret set <service> --command <CMD>` (dynamic source, no stdin)
    - value:   `sbx secret set <service>` with value piped over STDIN

    The raw value is never placed in argv.
    """
    if service not in SERVICES:
        return 400, {"error": f"unknown service '{service}'"}
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH"}

    args = ["secret", "set", service, *_scope_args(scope)]
    stdin: str | None = None

    if oauth:
        args.append("--oauth")
    elif ref:
        args += ["--ref", ref]
        if refresh:
            args += ["--refresh", refresh]
    elif command:
        args += ["--command", command]
        if refresh:
            args += ["--refresh", refresh]
    elif value is not None and value != "":
        stdin = value  # piped to stdin, never argv
    else:
        return 400, {"error": "no secret source provided (value, oauth, ref, or command)"}

    result = sbx.run_sbx(args, stdin=stdin)
    if not result.ok:
        return 502, {"error": result.stderr.strip() or "sbx secret set failed"}
    return 200, {"ok": True, "service": service}


def remove_secret(service: str, *, scope: str | None = None, force: bool = True):
    """DELETE: remove a secret. `-f` by default (UI confirms before calling)."""
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH"}
    args = ["secret", "rm", service, *_scope_args(scope)]
    if force:
        args.append("-f")
    result = sbx.run_sbx(args)
    if not result.ok:
        return 502, {"error": result.stderr.strip() or "sbx secret rm failed"}
    return 200, {"ok": True, "service": service}
