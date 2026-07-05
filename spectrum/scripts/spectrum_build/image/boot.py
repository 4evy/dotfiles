from __future__ import annotations

import sys
from pathlib import Path

from spectrum_build.image.formatting import format_bytes


def report_boot_artifacts() -> None:
    for directory in (Path("/boot"), Path("/usr/lib/modules")):
        if not directory.exists():
            continue

        files = sorted(path for path in directory.rglob("*") if path.is_file())
        if not files:
            print(f"No boot artifacts under {directory}", file=sys.stderr)
            continue

        total = sum(path.stat().st_size for path in files)
        print(
            f"Boot artifact footprint under {directory}: "
            f"{format_bytes(total)} across {len(files)} files",
            file=sys.stderr,
        )
