#!/usr/bin/env python3.14
"""Keep Toshy's nested sudo calls non-interactive under Ansible."""

import os
import sys
from pathlib import Path


def main() -> int:
    arguments = list(sys.argv[1:])
    if arguments[:1] == ["-k"]:
        return 0
    if arguments[:1] == ["-n"]:
        arguments.pop(0)

    sudo = os.environ.get("TOSHY_SUDO")
    if not sudo:
        own_path = Path(sys.argv[0]).resolve()
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            candidate = Path(directory or ".") / "sudo"
            if (
                candidate.is_file()
                and os.access(candidate, os.X_OK)
                and candidate.resolve() != own_path
            ):
                sudo = os.fspath(candidate)
                break

    if not sudo:
        print("Toshy setup: sudo is not available on PATH", file=sys.stderr)
        return 127

    os.execv(sudo, (sudo, "-n", *arguments))
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
