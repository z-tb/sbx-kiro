"""Thin wrapper around the `sbx` CLI.

The HTTP layer never builds argv or shells out directly — it always goes
through here. This keeps the subprocess boundary (and its safety rules) in
one place: list-form args, no shell=True, timeouts, and secret values passed
over stdin rather than as command-line arguments.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass

SBX_BIN = "sbx"
DEFAULT_TIMEOUT = 30  # seconds


@dataclass
class SbxResult:
    rc: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.rc == 0


class SbxNotFound(RuntimeError):
    """Raised when the `sbx` binary is not on PATH."""


def sbx_available() -> bool:
    return shutil.which(SBX_BIN) is not None


def run_sbx(
    args: list[str],
    *,
    stdin: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> SbxResult:
    """Invoke `sbx` with list-form args.

    - args: argv AFTER the `sbx` binary, e.g. ["secret", "ls", "--json"].
    - stdin: optional string piped to the process stdin. Use this for secret
      values so they never appear in argv / `ps` / `/proc/<pid>/cmdline`.
    - never uses shell=True; never interpolates values into a shell string.
    """
    if shutil.which(SBX_BIN) is None:
        raise SbxNotFound(f"'{SBX_BIN}' not found on PATH")

    proc = subprocess.run(  # noqa: S603 - fixed binary, list-form args, no shell
        [SBX_BIN, *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return SbxResult(rc=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)


def run_sbx_json(args: list[str], *, timeout: float = DEFAULT_TIMEOUT):
    """Run an sbx command expected to emit JSON on stdout and parse it.

    Returns (result, parsed). `parsed` is None when rc != 0 or stdout is not
    valid JSON. Callers decide how to surface failures.
    """
    result = run_sbx(args, timeout=timeout)
    parsed = None
    if result.ok and result.stdout.strip():
        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError:
            parsed = None
    return result, parsed
