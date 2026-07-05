#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if not shutil.which("uv"):
        print("error: uv is required to run Spectrum build tooling", file=sys.stderr)
        return 1

    project_dir = Path(__file__).resolve().parents[2]
    return subprocess.run(
        [
            "uv",
            "--directory",
            project_dir,
            "run",
            "--locked",
            "spectrum-build",
            *sys.argv[1:],
        ],
        env=os.environ,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
