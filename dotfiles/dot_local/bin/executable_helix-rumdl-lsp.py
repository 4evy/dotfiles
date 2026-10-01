#!/usr/bin/env python3.14
"""Run rumdl while hiding diagnostics for files in the OS temp directory."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".local/lib/python"))
from lsp_jsonrpc import (
    DiagnosticFilter,
    proxy_lsp_server,
)

TEMPORARY_DIRECTORY = Path(tempfile.gettempdir()).resolve()


def is_temporary_uri(uri: object) -> bool:
    if not isinstance(uri, str):
        return False
    try:
        document = Path.from_uri(uri).resolve()
    except ValueError:
        return False
    return document.is_relative_to(TEMPORARY_DIRECTORY)


def main() -> int:
    rumdl = shutil.which("rumdl")
    if rumdl is None:
        raise RuntimeError("rumdl is not installed or is missing from PATH")
    diagnostics = DiagnosticFilter(is_temporary_uri)
    return proxy_lsp_server(
        (rumdl, "server"),
        diagnostics.observe,
        diagnostics.filter,
    )


if __name__ == "__main__":
    raise SystemExit(main())
