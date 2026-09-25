#!/usr/bin/env python3.14
"""Run just-lsp without its unreliable imported-Justfile diagnostics."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".local/lib/python"))
from lsp_jsonrpc import (
    proxy_lsp_server,
)

DIAGNOSTIC_REQUESTS: dict[int | str, str] = {}
REQUESTS_LOCK = threading.Lock()


def track_client_request(body: bytes) -> None:
    try:
        message = json.loads(body)
    except json.JSONDecodeError, UnicodeDecodeError:
        return
    method = message.get("method")
    request_id = message.get("id")
    if method not in {
        "textDocument/diagnostic",
        "workspace/diagnostic",
    } or not isinstance(request_id, (int, str)):
        return
    with REQUESTS_LOCK:
        DIAGNOSTIC_REQUESTS[request_id] = method


def filter_server_message(body: bytes) -> bytes:
    try:
        message = json.loads(body)
    except json.JSONDecodeError, UnicodeDecodeError:
        return body
    if message.get("method") == "textDocument/publishDiagnostics":
        params = message.get("params")
        if not isinstance(params, dict):
            return body
        params["diagnostics"] = []
        return json.dumps(message, separators=(",", ":")).encode()
    request_id = message.get("id")
    if not isinstance(request_id, (int, str)):
        return body
    with REQUESTS_LOCK:
        method = DIAGNOSTIC_REQUESTS.pop(request_id, None)
    if method is None or "result" not in message:
        return body
    message["result"] = (
        {"items": []}
        if method == "workspace/diagnostic"
        else {"kind": "full", "items": []}
    )
    return json.dumps(message, separators=(",", ":")).encode()


def main() -> int:
    just_lsp = shutil.which("just-lsp")
    if just_lsp is None:
        raise RuntimeError("just-lsp is not installed or is missing from PATH")
    if sys.argv[1:]:
        return subprocess.run((just_lsp, *sys.argv[1:]), check=False).returncode
    return proxy_lsp_server(
        (just_lsp,),
        track_client_request,
        filter_server_message,
    )


if __name__ == "__main__":
    raise SystemExit(main())
