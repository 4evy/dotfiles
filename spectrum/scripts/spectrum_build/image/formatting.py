from __future__ import annotations

from pathlib import Path

import humanize


def format_bytes(size: int) -> str:
    return humanize.naturalsize(size, binary=True, format="%.1f")


def tree_size(path: Path) -> int:
    return sum(
        item.stat().st_size
        for item in path.rglob("*")
        if item.is_file() and not item.is_symlink()
    )
