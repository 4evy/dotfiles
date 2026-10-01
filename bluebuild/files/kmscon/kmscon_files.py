#!/usr/bin/env python3.14
"""Small, durable file operations shared by KMSCON helpers."""

import os
import tempfile
from pathlib import Path


def write_if_changed(path: Path, content: str, mode: int = 0o644) -> bool:
    """Atomically write text when its persisted value differs."""
    if path.is_file() and path.read_text(encoding="utf-8") == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}-",
        delete_on_close=False,
    ) as temporary:
        temporary.write(content)
        temporary.flush()
        os.fchmod(temporary.fileno(), mode)
        temporary.close()
        Path(temporary.name).replace(path)
    return True
