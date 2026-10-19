#!/usr/bin/env python3.14
"""Run Toshy's installer for user files with deterministic prompt answers."""

import argparse
import builtins
import runpy
import sys
from pathlib import Path


def automated_input(prompt: object = "") -> str:
    text = str(prompt)
    answer = (
        "YES"
        if "barebones" in text.casefold()
        and 'enter "yes" to proceed' in text.casefold()
        else ""
    )
    print(text + answer, flush=True)
    return answer


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("setup_path", type=Path)
    options = parser.parse_args()
    source = options.setup_path.resolve()
    sys.path.insert(0, str(source.parent))
    builtins.input = automated_input  # ty: ignore[invalid-assignment]
    sys.argv = [str(source), "install-user-files", "--barebones-config"]
    runpy.run_path(str(source), run_name="__main__")


if __name__ == "__main__":
    main()
