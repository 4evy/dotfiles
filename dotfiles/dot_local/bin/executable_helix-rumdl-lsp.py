#!/usr/bin/env python3.14
"""Run rumdl while hiding diagnostics for files in the OS temp directory."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".local/lib/python"))
from lsp_jsonrpc import (
    proxy_lsp_server,
)

TEMPORARY_DIRECTORY = Path(tempfile.gettempdir()).resolve()
TEMPORARY_DIAGNOSTIC_REQUESTS: set[int | str] = set()
REQUESTS_LOCK = threading.Lock()


def is_temporary_uri(uri: object) -> bool:
    if not isinstance(uri, str):
        return False
    try:
        document = Path.from_uri(uri).resolve()
    except ValueError:
        return False
    return document.is_relative_to(TEMPORARY_DIRECTORY)


def track_client_request(body: bytes) -> None:
    try:
        message = json.loads(body)
    except json.JSONDecodeError, UnicodeDecodeError:
        return
    if message.get("method") != "textDocument/diagnostic":
        return
    params = message.get("params")
    text_document = params.get("textDocument") if isinstance(params, dict) else None
    uri = text_document.get("uri") if isinstance(text_document, dict) else None
    request_id = message.get("id")
    if not is_temporary_uri(uri) or not isinstance(request_id, (int, str)):
        return
    with REQUESTS_LOCK:
        TEMPORARY_DIAGNOSTIC_REQUESTS.add(request_id)


def filter_server_message(body: bytes) -> bytes:
    try:
        message = json.loads(body)
    except json.JSONDecodeError, UnicodeDecodeError:
        return body
    if message.get("method") == "textDocument/publishDiagnostics":
        params = message.get("params")
        if not isinstance(params, dict) or not is_temporary_uri(params.get("uri")):
            return body
        params["diagnostics"] = []
        return json.dumps(message, separators=(",", ":")).encode()
    request_id = message.get("id")
    if not isinstance(request_id, (int, str)):
        return body
    with REQUESTS_LOCK:
        if request_id not in TEMPORARY_DIAGNOSTIC_REQUESTS:
            return body
        TEMPORARY_DIAGNOSTIC_REQUESTS.remove(request_id)
    if "result" not in message:
        return body
    message["result"] = {"kind": "full", "items": []}
    return json.dumps(message, separators=(",", ":")).encode()


def main() -> int:
    rumdl = shutil.which("rumdl")
    if rumdl is None:
        raise RuntimeError("rumdl is not installed or is missing from PATH")
    return proxy_lsp_server(
        (rumdl, "server"),
        track_client_request,
        filter_server_message,
    )


if __name__ == "__main__":
    raise SystemExit(main())
