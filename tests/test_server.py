"""Tests for app/server.py API handlers that don't need a live socket.

These call the handler functions directly, stubbing the sbx layer, so we can
assert response shaping — in particular that `sbx ls --json`'s
{"sandboxes": [...]} wrapper is unwrapped into a flat list for the client.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from app import server, sbx


def _decode(resp):
    status, headers, body = resp
    return status, json.loads(body.decode("utf-8"))


class SandboxesHandlerTests(unittest.TestCase):
    def test_unwraps_sandboxes_object(self):
        real = {
            "sandboxes": [
                {"name": "alpine-shell", "status": "stopped"},
                {"name": "kiro-llm", "status": "running"},
            ]
        }
        with mock.patch.object(sbx, "sbx_available", return_value=True), \
             mock.patch.object(sbx, "run_sbx_json",
                               return_value=(sbx.SbxResult(0, "", ""), real)):
            status, payload = _decode(server.api_sandboxes(None))
        self.assertEqual(status, 200)
        names = [s["name"] for s in payload["sandboxes"]]
        self.assertEqual(names, ["alpine-shell", "kiro-llm"])

    def test_accepts_bare_list(self):
        bare = [{"name": "box1"}]
        with mock.patch.object(sbx, "sbx_available", return_value=True), \
             mock.patch.object(sbx, "run_sbx_json",
                               return_value=(sbx.SbxResult(0, "", ""), bare)):
            status, payload = _decode(server.api_sandboxes(None))
        self.assertEqual(status, 200)
        self.assertEqual(payload["sandboxes"], bare)

    def test_missing_binary_503(self):
        with mock.patch.object(sbx, "sbx_available", return_value=False):
            status, payload = _decode(server.api_sandboxes(None))
        self.assertEqual(status, 503)
        self.assertEqual(payload["sandboxes"], [])

    def test_sbx_failure_502(self):
        with mock.patch.object(sbx, "sbx_available", return_value=True), \
             mock.patch.object(sbx, "run_sbx_json",
                               return_value=(sbx.SbxResult(1, "", "daemon down"), None)):
            status, payload = _decode(server.api_sandboxes(None))
        self.assertEqual(status, 502)
        self.assertEqual(payload["error"], "daemon down")


if __name__ == "__main__":
    unittest.main()
