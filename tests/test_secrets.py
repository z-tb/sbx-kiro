"""Unit tests for app/features/secrets.py argv + stdin construction.

Reuses the fake-sbx-on-PATH approach from test_sbx: the fake records argv and
stdin so we can assert each handler builds the right command and that secret
values travel via stdin, never argv.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from app.features import secrets

FAKE_SBX = """#!{python}
import json, os, sys
record = {{"argv": sys.argv[1:], "stdin": sys.stdin.read()}}
with open(os.environ["SBX_RECORD"], "w") as f:
    json.dump(record, f)
sys.stdout.write(os.environ.get("SBX_STDOUT", ""))
sys.stderr.write(os.environ.get("SBX_STDERR", ""))
sys.exit(int(os.environ.get("SBX_RC", "0")))
"""


class SecretsHandlerTests(unittest.TestCase):
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
    def test_list_all_scopes(self):
        os.environ["SBX_STDOUT"] = "[]"
        status, payload = secrets.list_secrets()
        self.assertEqual(status, 200)
        self.assertEqual(self._record()["argv"], ["secret", "ls", "--json"])

    def test_list_global_uses_global_flag(self):
        os.environ["SBX_STDOUT"] = "[]"
        secrets.list_secrets(scope=secrets.GLOBAL)
        self.assertEqual(self._record()["argv"], ["secret", "ls", "--json", "--global"])

    def test_list_sandbox_scope_and_service(self):
        os.environ["SBX_STDOUT"] = "[]"
        secrets.list_secrets(scope="box1", service="github")
        self.assertEqual(
            self._record()["argv"],
            ["secret", "ls", "--json", "--sandbox", "box1", "--service", "github"],
        )

    def test_list_unwraps_real_object_shape(self):
        os.environ["SBX_STDOUT"] = (
            '{"secrets":[{"scope":"global","type":"service",'
            '"name":"foobarsecret","secret":"(stored)"}],'
            '"custom_secrets":[],"shadowed_services":[],"env_only_count":0}'
        )
        status, payload = secrets.list_secrets()
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["secrets"]), 1)
        self.assertEqual(payload["secrets"][0]["name"], "foobarsecret")
        self.assertEqual(payload["custom_secrets"], [])
        # The placeholder is passed through; no real value is ever present.
        self.assertEqual(payload["secrets"][0]["secret"], "(stored)")

    # -- set: value via stdin ---------------------------------------------
    def test_set_value_goes_via_stdin_not_argv(self):
        status, _ = secrets.set_secret("github", value="ghp_SECRETTOKEN")
        self.assertEqual(status, 200)
        rec = self._record()
        self.assertEqual(rec["argv"], ["secret", "set", "github"])
        self.assertEqual(rec["stdin"], "ghp_SECRETTOKEN")
        self.assertNotIn("ghp_SECRETTOKEN", "".join(rec["argv"]))

    def test_set_value_with_sandbox_scope(self):
        secrets.set_secret("openai", value="sk-x", scope="box1")
        rec = self._record()
        self.assertEqual(rec["argv"], ["secret", "set", "openai", "--sandbox", "box1"])
        self.assertEqual(rec["stdin"], "sk-x")

    def test_set_global_scope_has_no_flag(self):
        secrets.set_secret("github", value="x", scope=secrets.GLOBAL)
        self.assertEqual(self._record()["argv"], ["secret", "set", "github"])

    # -- set: oauth / ref / command (no stdin) ----------------------------
    def test_set_oauth_no_stdin(self):
        secrets.set_secret("openai", oauth=True)
        rec = self._record()
        self.assertEqual(rec["argv"], ["secret", "set", "openai", "--oauth"])
        self.assertEqual(rec["stdin"], "")

    def test_set_ref_with_refresh(self):
        secrets.set_secret("anthropic", ref="op://Private/Anthropic/api-key", refresh="30m")
        rec = self._record()
        self.assertEqual(
            rec["argv"],
            ["secret", "set", "anthropic", "--ref", "op://Private/Anthropic/api-key",
             "--refresh", "30m"],
        )
        self.assertEqual(rec["stdin"], "")

    def test_set_command_source(self):
        secrets.set_secret("github", command="gh auth token")
        rec = self._record()
        self.assertEqual(rec["argv"], ["secret", "set", "github", "--command", "gh auth token"])

    # -- set: validation ---------------------------------------------------
    def test_set_unknown_service_rejected(self):
        status, payload = secrets.set_secret("notaservice", value="x")
        self.assertEqual(status, 400)
        self.assertIn("unknown service", payload["error"])

    def test_set_no_source_rejected(self):
        status, payload = secrets.set_secret("github")
        self.assertEqual(status, 400)

    # -- remove ------------------------------------------------------------
    def test_remove_global_force(self):
        secrets.remove_secret("github")
        self.assertEqual(self._record()["argv"], ["secret", "rm", "github", "-f"])

    def test_remove_sandbox_scope(self):
        secrets.remove_secret("openai", scope="box1")
        self.assertEqual(
            self._record()["argv"], ["secret", "rm", "openai", "--sandbox", "box1", "-f"]
        )

    # -- error propagation -------------------------------------------------
    def test_set_surfaces_sbx_error(self):
        os.environ["SBX_RC"] = "1"
        os.environ["SBX_STDERR"] = "boom"
        status, payload = secrets.set_secret("github", value="x")
        self.assertEqual(status, 502)
        self.assertEqual(payload["error"], "boom")


if __name__ == "__main__":
    unittest.main()
