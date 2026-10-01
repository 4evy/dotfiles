#!/usr/bin/env python3.14
"""Run just-lsp without its unreliable imported-Justfile diagnostics."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".local/lib/python"))
from lsp_jsonrpc import (
    DiagnosticFilter,
    proxy_lsp_server,
)


def main() -> int:
    just_lsp = shutil.which("just-lsp")
    if just_lsp is None:
        raise RuntimeError("just-lsp is not installed or is missing from PATH")
    if sys.argv[1:]:
        return subprocess.run((just_lsp, *sys.argv[1:]), check=False).returncode
    diagnostics = DiagnosticFilter(lambda _uri: True, workspace=True)
    return proxy_lsp_server(
        (just_lsp,),
        diagnostics.observe,
        diagnostics.filter,
    )


if __name__ == "__main__":
    raise SystemExit(main())
