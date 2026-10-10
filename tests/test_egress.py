"""Unit tests for app/features/egress.py argv construction + rules shaping.

Uses the fake-sbx-on-PATH pattern. Includes the real `policy ls --wide --json`
shape to verify unwrapping of the "rules" key and filtering to network rules.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from app.features import egress

FAKE_SBX = """#!{python}
import json, os, sys
record = {{"argv": sys.argv[1:], "stdin": sys.stdin.read()}}
with open(os.environ["SBX_RECORD"], "w") as f:
    json.dump(record, f)
sys.stdout.write(os.environ.get("SBX_STDOUT", ""))
sys.stderr.write(os.environ.get("SBX_STDERR", ""))
sys.exit(int(os.environ.get("SBX_RC", "0")))
"""

REAL_LS = json.dumps({
    "rules": [
        {"id": "default-fs-read-allow-all", "resource_type": "filesystem:read",
         "decision": "allow", "resources": ["**"], "scope": "global",
         "origin": "local", "status": "active", "editable": False},
        {"id": "27761ea0-8ece-4b74-8a46-93e0d158d50c", "name": "kit:kiro-llm",
         "resource_type": "network", "decision": "allow",
         "resources": ["cli.kiro.dev", "*.kiro.dev"], "scope": "sandbox:kiro-llm",
         "origin": "scoped", "status": "active", "editable": False},
    ]
})


class EgressHandlerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bindir = Path(self.tmp.name) / "bin"
        self.bindir.mkdir()
        fake = self.bindir / "sbx"
        fake.write_text(FAKE_SBX.format(python=sys.executable))
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        self.record_path = Path(self.tmp.name) / "record.json"
        self._old_path = os.environ["PATH"]
        os.environ["PATH"] = f"{self.bindir}{os.pathsep}{self._old_path}"
        os.environ["SBX_RECORD"] = str(self.record_path)
        for k in ("SBX_STDOUT", "SBX_STDERR", "SBX_RC"):
            os.environ.pop(k, None)

    def tearDown(self):
        os.environ["PATH"] = self._old_path
        for k in ("SBX_RECORD", "SBX_STDOUT", "SBX_STDERR", "SBX_RC"):
            os.environ.pop(k, None)
        self.tmp.cleanup()

    def _record(self):
        return json.loads(self.record_path.read_text())

    # -- list --------------------------------------------------------------
    def test_list_global_argv(self):
        os.environ["SBX_STDOUT"] = REAL_LS
        egress.list_rules()
        self.assertEqual(
            self._record()["argv"],
            ["policy", "ls", "--wide", "--type", "network", "--json"],
        )

    def test_list_sandbox_positional(self):
        os.environ["SBX_STDOUT"] = REAL_LS
        egress.list_rules(scope="kiro-llm")
        self.assertEqual(
            self._record()["argv"],
            ["policy", "ls", "kiro-llm", "--wide", "--type", "network", "--json"],
        )

    def test_list_unwraps_and_filters_network_only(self):
        os.environ["SBX_STDOUT"] = REAL_LS
        status, payload = egress.list_rules()
        self.assertEqual(status, 200)
        # Only the network rule survives; the filesystem rule is dropped.
        self.assertEqual(len(payload["rules"]), 1)
        self.assertEqual(payload["rules"][0]["resource_type"], "network")
        self.assertFalse(payload["rules"][0]["editable"])

    # -- allow / deny ------------------------------------------------------
    def test_allow_joins_resources_single_call(self):
        egress.allow(["api.example.com:443", "*.npmjs.org"])
        self.assertEqual(
            self._record()["argv"],
            ["policy", "allow", "network", "api.example.com:443,*.npmjs.org"],
        )

    def test_allow_with_sandbox_and_protocol(self):
        egress.allow("api.example.com", scope="box1", protocol="tcp,udp")
        self.assertEqual(
            self._record()["argv"],
            ["policy", "allow", "network", "--sandbox", "box1",
             "--protocol", "tcp,udp", "api.example.com"],
        )

    def test_allow_global_no_sandbox_flag(self):
        egress.allow("api.example.com", scope=egress.GLOBAL)
        self.assertEqual(
            self._record()["argv"], ["policy", "allow", "network", "api.example.com"]
        )

    def test_deny_argv(self):
        egress.deny("evil.example.com")
        self.assertEqual(
            self._record()["argv"], ["policy", "deny", "network", "evil.example.com"]
        )

    def test_allow_empty_resources_rejected(self):
        status, payload = egress.allow("  ,  ")
        self.assertEqual(status, 400)

    # -- check -------------------------------------------------------------
    def test_check_argv_and_result(self):
        os.environ["SBX_STDOUT"] = "allowed"
        status, payload = egress.check("api.example.com", scope="box1")
        self.assertEqual(status, 200)
        self.assertTrue(payload["allowed"])
        self.assertEqual(
            self._record()["argv"],
            ["policy", "check", "network", "--sandbox", "box1", "api.example.com"],
        )

    def test_check_blocked_when_rc_nonzero(self):
        os.environ["SBX_RC"] = "1"
        os.environ["SBX_STDOUT"] = "blocked"
        status, payload = egress.check("evil.example.com")
        self.assertEqual(status, 200)
        self.assertFalse(payload["allowed"])

    # -- remove ------------------------------------------------------------
    def test_remove_by_id(self):
        egress.remove("27761ea0-8ece-4b74-8a46-93e0d158d50c")
        self.assertEqual(
            self._record()["argv"],
            ["policy", "rm", "network", "--force", "--id", "27761ea0-8ece-4b74-8a46-93e0d158d50c"],
        )

    def test_remove_sandbox_scoped(self):
        egress.remove("9bf5b0af-ab31-4eec-a526-54a99f1f1b1e", scope="kiro-llm")
        self.assertEqual(
            self._record()["argv"],
            ["policy", "rm", "network", "--force", "--id",
             "9bf5b0af-ab31-4eec-a526-54a99f1f1b1e", "--sandbox", "kiro-llm"],
        )

    def test_remove_global_scope_no_sandbox_flag(self):
        egress.remove("abc", scope=egress.GLOBAL)
        self.assertEqual(
            self._record()["argv"], ["policy", "rm", "network", "--force", "--id", "abc"]
        )

    def test_remove_empty_id_rejected(self):
        status, _ = egress.remove("   ")
        self.assertEqual(status, 400)

    # -- init --------------------------------------------------------------
    def test_init_valid_mode(self):
        egress.init("balanced")
        self.assertEqual(self._record()["argv"], ["policy", "init", "balanced"])

    def test_init_invalid_mode_rejected(self):
        status, _ = egress.init("bogus")
        self.assertEqual(status, 400)

    # -- log ---------------------------------------------------------------
    def test_log_argv_global(self):
        os.environ["SBX_STDOUT"] = '{"blocked_hosts":[],"allowed_hosts":[]}'
        egress.log()
        self.assertEqual(
            self._record()["argv"],
            ["policy", "log", "--json", "--type", "network"],
        )

    def test_log_argv_sandbox_positional(self):
        os.environ["SBX_STDOUT"] = '{"blocked_hosts":[],"allowed_hosts":[]}'
        egress.log(scope="kiro-llm")
        self.assertEqual(
            self._record()["argv"],
            ["policy", "log", "kiro-llm", "--json", "--type", "network"],
        )

    def test_log_splits_blocked_and_allowed(self):
        os.environ["SBX_STDOUT"] = (
            '{"blocked_hosts":[{"host":"api.github.com:443","count_since":536,'
            '"reason":"No matching allow rule (default deny)"}],'
            '"allowed_hosts":[{"host":"telemetry.us-east-1.kiro.dev:443",'
            '"proxy_type":"transparent","count_since":158}]}'
        )
        status, payload = egress.log(scope="kiro-llm")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["blocked"]), 1)
        self.assertEqual(payload["blocked"][0]["host"], "api.github.com:443")
        self.assertEqual(payload["blocked"][0]["reason"],
                         "No matching allow rule (default deny)")
        self.assertEqual(len(payload["allowed"]), 1)
        self.assertEqual(payload["allowed"][0]["proxy_type"], "transparent")

    def test_log_failure_502(self):
        os.environ["SBX_RC"] = "1"
        os.environ["SBX_STDERR"] = "daemon down"
        status, payload = egress.log()
        self.assertEqual(status, 502)
        self.assertEqual(payload["blocked"], [])
        self.assertEqual(payload["allowed"], [])


if __name__ == "__main__":
    unittest.main()
