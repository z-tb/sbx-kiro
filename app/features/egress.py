"""Egress feature — maps UI actions to `sbx policy ...` commands.

Aligned to the real `sbx policy ls --wide --json` shape:
  {"rules": [ { "id","name","scope","applies_to","resource_type",
               "decision","resources":[...],"origin","layer","status",
               "editable", "provenance":{...} }, ... ]}

We care about resource_type == "network". `editable` gates removal (local
rules only; defaults/org/kit rules are read-only). Removal uses the rule `id`
with `policy rm network --id`.

Scope model (from the allow/deny leaf help):
- global by default (omit --sandbox)
- --sandbox <name> scopes to that sandbox's local policy
RESOURCES is a comma-separated list; the leaf accepts wildcards/globs/ports/CIDR.
"""
from __future__ import annotations

from .. import sbx

GLOBAL = "__global__"
INIT_MODES = ("allow-all", "balanced", "deny-all")


def _scope_args(scope: str | None) -> list[str]:
    if scope in (None, GLOBAL):
        return []
    return ["--sandbox", scope]


def _protocol_args(protocol: str | None) -> list[str]:
    # Accepts "tcp", "udp", or "tcp,udp"; the leaf flag takes comma-separated.
    if not protocol:
        return []
    return ["--protocol", protocol]


def list_rules(scope: str | None = None):
    """List network rules. scope None/GLOBAL -> all; else that sandbox.

    Uses `policy ls [SANDBOX] --wide --type network --json`, unwraps the
    "rules" key, and keeps only network rules (defensive against --type being
    ignored).
    """
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH", "rules": []}

    args = ["policy", "ls"]
    if scope not in (None, GLOBAL):
        args.append(scope)  # SANDBOX is a positional, not a flag
    args += ["--wide", "--type", "network", "--json"]

    result, parsed = sbx.run_sbx_json(args)
    if not result.ok:
        return 502, {"error": result.stderr.strip() or "sbx policy ls failed", "rules": []}

    if isinstance(parsed, dict):
        rules = parsed.get("rules", []) or []
    elif isinstance(parsed, list):
        rules = parsed
    else:
        rules = []
    rules = [r for r in rules if r.get("resource_type") == "network"]
    return 200, {"rules": rules}


def _add_rule(verb: str, resources, scope, protocol):
    """Shared allow/deny builder. `resources` is a list or comma string."""
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH"}
    if isinstance(resources, (list, tuple)):
        joined = ",".join(r.strip() for r in resources if r.strip())
    else:
        joined = ",".join(p.strip() for p in str(resources).split(",") if p.strip())
    if not joined:
        return 400, {"error": "no resources provided"}

    args = ["policy", verb, "network", *_scope_args(scope), *_protocol_args(protocol), joined]
    result = sbx.run_sbx(args)
    if not result.ok:
        return 502, {"error": result.stderr.strip() or f"sbx policy {verb} failed"}
    return 200, {"ok": True, "resources": joined}


def allow(resources, *, scope: str | None = None, protocol: str | None = None):
    return _add_rule("allow", resources, scope, protocol)


def deny(resources, *, scope: str | None = None, protocol: str | None = None):
    return _add_rule("deny", resources, scope, protocol)


def check(host: str, *, scope: str | None = None):
    """Read-only authorization check for a host."""
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH"}
    if not host.strip():
        return 400, {"error": "host is required"}
    args = ["policy", "check", "network", *_scope_args(scope), host.strip()]
    result = sbx.run_sbx(args)
    # check is read-only; surface stdout verbatim (decision text) + rc.
    return 200, {
        "allowed": result.ok,
        "output": (result.stdout or result.stderr).strip(),
    }


def remove(rule_id: str, scope: str | None = None):
    """Remove a network rule by RULE_ID.

    Sandbox-scoped rules must be removed with --sandbox; a global --id lookup
    fails for them (sbx names the required command in its error). `scope` is the
    sandbox name, or None/GLOBAL for the global policy.
    """
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH"}
    if not rule_id.strip():
        return 400, {"error": "rule id is required"}
    # -f/--force skips the interactive confirmation prompt; without it the
    # command blocks on stdin and the subprocess times out.
    args = ["policy", "rm", "network", "--force", "--id", rule_id.strip(), *_scope_args(scope)]
    result = sbx.run_sbx(args)
    if not result.ok:
        return 502, {"error": result.stderr.strip() or "sbx policy rm failed"}
    return 200, {"ok": True, "id": rule_id}


def init(mode: str):
    """One-time global network policy initialization."""
    if mode not in INIT_MODES:
        return 400, {"error": f"mode must be one of {INIT_MODES}"}
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH"}
    result = sbx.run_sbx(["policy", "init", mode])
    if not result.ok:
        return 502, {"error": result.stderr.strip() or "sbx policy init failed"}
    return 200, {"ok": True, "mode": mode}


def log(scope: str | None = None):
    """Policy activity log: which hosts were blocked / allowed by the proxy.

    `sbx policy log [SANDBOX] --json --type network` returns:
      {"blocked_hosts": [...], "allowed_hosts": [...]}
    Each entry: host, vm_name, proxy_type, rule, last_seen, since,
    count_since, and (blocked only) reason.
    """
    if not sbx.sbx_available():
        return 503, {"error": "sbx CLI not found on PATH", "blocked": [], "allowed": []}

    args = ["policy", "log"]
    if scope not in (None, GLOBAL):
        args.append(scope)  # SANDBOX positional
    args += ["--json", "--type", "network"]

    result, parsed = sbx.run_sbx_json(args)
    if not result.ok:
        return 502, {
            "error": result.stderr.strip() or "sbx policy log failed",
            "blocked": [],
            "allowed": [],
        }
    if isinstance(parsed, dict):
        blocked = parsed.get("blocked_hosts", []) or []
        allowed = parsed.get("allowed_hosts", []) or []
    else:
        blocked, allowed = [], []
    return 200, {"blocked": blocked, "allowed": allowed}
