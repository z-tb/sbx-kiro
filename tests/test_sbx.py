"""Unit tests for app/sbx.py argv + stdin construction.

Strategy: install a fake `sbx` executable on PATH that records exactly how it
was invoked (argv + stdin) to a JSON file, then assert run_sbx built the
command correctly and delivered stdin. This verifies the real subprocess path
(list-form argv, no shell) rather than mocking it away.
"""
from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from app import sbx

FAKE_SBX = """#!{python}
import json, os, sys
record = {{
    "argv": sys.argv[1:],
    "stdin": sys.stdin.read(),
}}
with open(os.environ["SBX_RECORD"], "w") as f:
    json.dump(record, f)
# Emit whatever the test asked for.
sys.stdout.write(os.environ.get("SBX_STDOUT", ""))
sys.stderr.write(os.environ.get("SBX_STDERR", ""))
sys.exit(int(os.environ.get("SBX_RC", "0")))
"""


class SbxWrapperTests(unittest.TestCase):
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
        os.environ.pop("SBX_STDOUT", None)
        os.environ.pop("SBX_STDERR", None)
        os.environ.pop("SBX_RC", None)

    def tearDown(self):
        os.environ["PATH"] = self._old_path
        for k in ("SBX_RECORD", "SBX_STDOUT", "SBX_STDERR", "SBX_RC"):
            os.environ.pop(k, None)
        self.tmp.cleanup()

    def _record(self):
        return json.loads(self.record_path.read_text())

    # -- argv construction -------------------------------------------------
    def test_available(self):
        self.assertTrue(sbx.sbx_available())

    def test_argv_is_list_form_after_binary(self):
        sbx.run_sbx(["secret", "ls", "--json"])
        rec = self._record()
        self.assertEqual(rec["argv"], ["secret", "ls", "--json"])

    def test_args_with_values_not_shell_interpolated(self):
        # A value containing shell metacharacters must be passed literally.
        tricky = "a b; rm -rf /:$(whoami)"
        sbx.run_sbx(["secret", "set", "--registry", tricky])
        rec = self._record()
        self.assertEqual(rec["argv"], ["secret", "set", "--registry", tricky])

    # -- stdin delivery ----------------------------------------------------
    def test_stdin_is_delivered(self):
        sbx.run_sbx(["secret", "set", "github"], stdin="supersecret\n")
        rec = self._record()
        self.assertEqual(rec["stdin"], "supersecret\n")
        # The secret value must NOT appear in argv.
        self.assertNotIn("supersecret", "".join(rec["argv"]))
        self.assertNotIn("supersecret\n", rec["argv"])

    def test_no_stdin_means_empty(self):
        sbx.run_sbx(["ls", "--json"])
        rec = self._record()
        self.assertEqual(rec["stdin"], "")

    # -- result handling ---------------------------------------------------
    def test_result_captures_rc_stdout_stderr(self):
        os.environ["SBX_STDOUT"] = "hello out"
        os.environ["SBX_STDERR"] = "warn err"
        os.environ["SBX_RC"] = "3"
        res = sbx.run_sbx(["whatever"])
        self.assertEqual(res.rc, 3)
        self.assertFalse(res.ok)
        self.assertEqual(res.stdout, "hello out")
        self.assertEqual(res.stderr, "warn err")

    def test_run_sbx_json_parses_valid_json(self):
        os.environ["SBX_STDOUT"] = '[{"name": "box1"}]'
        res, parsed = sbx.run_sbx_json(["ls", "--json"])
        self.assertTrue(res.ok)
        self.assertEqual(parsed, [{"name": "box1"}])

    def test_run_sbx_json_none_on_bad_json(self):
        os.environ["SBX_STDOUT"] = "not json"
        res, parsed = sbx.run_sbx_json(["ls", "--json"])
        self.assertTrue(res.ok)
        self.assertIsNone(parsed)

    def test_run_sbx_json_none_on_failure(self):
        os.environ["SBX_STDOUT"] = '[{"name": "box1"}]'
        os.environ["SBX_RC"] = "1"
        res, parsed = sbx.run_sbx_json(["ls", "--json"])
        self.assertFalse(res.ok)
        self.assertIsNone(parsed)

    # -- missing binary ----------------------------------------------------
    def test_not_found_raises(self):
        os.environ["PATH"] = ""  # hide the fake sbx
        with self.assertRaises(sbx.SbxNotFound):
            sbx.run_sbx(["ls"])


if __name__ == "__main__":
    unittest.main()
