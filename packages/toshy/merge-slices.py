#!/usr/bin/env python3
"""Merge dotfiles Toshy slices into an upstream Toshy config.

Toshy's installer preserves named regions delimited by SLICE_MARK comments.
Using the same boundary keeps our config customizations compatible with
host-installed Toshy on Bluefin.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


MARKER_RE = re.compile(
    r"(?P<start>^###  SLICE_MARK_START: (?P<name>\w+)  ###[^\n]*\n)"
    r"(?P<body>.*?)"
    r"(?P<end>^###  SLICE_MARK_END: (?P=name)  ###[^\n]*$)",
    re.MULTILINE | re.DOTALL,
)


def read_slices(slice_dir: Path) -> dict[str, str]:
    slices = {}
    for path in sorted(slice_dir.glob("*.py")):
        slices[path.stem] = path.read_text(encoding="utf-8").strip() + "\n"

    if not slices:
        raise SystemExit(f"No Toshy slice files found in {slice_dir}")

    return slices


def merge_slices(config: str, slices: dict[str, str]) -> str:
    found = set()

    def replace(match: re.Match[str]) -> str:
        name = match.group("name")
        if name not in slices:
            return match.group(0)

        found.add(name)
        return f"{match.group('start')}\n{slices[name]}\n{match.group('end')}"

    merged = MARKER_RE.sub(replace, config)
    missing = sorted(set(slices) - found)
    if missing:
        raise SystemExit(
            f"Config is missing Toshy slice marker(s): {', '.join(missing)}"
        )

    return merged


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path, help="Base Toshy config to read")
    parser.add_argument(
        "slice_dir", type=Path, help="Directory of <slice-name>.py files"
    )
    parser.add_argument(
        "output",
        nargs="?",
        type=Path,
        help="Output config path. Defaults to updating config in place.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output or args.config

    config = args.config.read_text(encoding="utf-8")
    merged = merge_slices(config, read_slices(args.slice_dir))
    output.write_text(merged, encoding="utf-8")


if __name__ == "__main__":
    main()
