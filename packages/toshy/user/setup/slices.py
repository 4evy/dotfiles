#!/usr/bin/env python3.14
"""Merge dotfiles-owned slices into an upstream Toshy config.

Toshy's installer preserves named regions delimited by SLICE_MARK comments.
Using those boundaries keeps the same customizations compatible with Toshy's
normal installer and its externally managed NixOS runtime.
"""

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
    slices = {
        path.stem: path.read_text(encoding="utf-8").strip() + "\n"
        for path in sorted(slice_dir.glob("*.py"))
    }
    if not slices:
        raise SystemExit(f"No Toshy slice files found in {slice_dir}")

    return slices


def extract_slices(config: str) -> dict[str, str]:
    return {
        match.group("name"): match.group("body").strip() + "\n"
        for match in MARKER_RE.finditer(config)
    }


def merge_slices(
    config: str,
    slices: dict[str, str],
    *,
    upstream_config: str | None = None,
    reset_slices: list[str] | None = None,
) -> str:
    replacements = dict(slices)
    reset_slices = reset_slices or []

    if reset_slices:
        if upstream_config is None:
            raise SystemExit("--reset-slice requires --upstream-config")

        upstream_slices = extract_slices(upstream_config)
        for name in reset_slices:
            if name in replacements:
                raise SystemExit(
                    f"Slice {name!r} cannot be both reset and dotfiles-managed"
                )
            if name not in upstream_slices:
                raise SystemExit(f"Upstream config is missing Toshy slice: {name}")
            replacements[name] = upstream_slices[name]

    found = set()

    def replace(match: re.Match[str]) -> str:
        name = match.group("name")
        if name not in replacements:
            return match.group(0)

        found.add(name)
        return f"{match.group('start')}\n{replacements[name]}\n{match.group('end')}"

    merged = MARKER_RE.sub(replace, config)
    missing = sorted(set(replacements) - found)
    if missing:
        raise SystemExit(
            f"Config is missing Toshy slice marker(s): {', '.join(missing)}"
        )

    return merged


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(suggest_on_error=True)
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
    parser.add_argument(
        "--upstream-config",
        type=Path,
        help="Pinned upstream config from which reset slices are restored.",
    )
    parser.add_argument(
        "--reset-slice",
        action="append",
        default=[],
        help="Restore this slice from --upstream-config before custom merging.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output or args.config

    config = args.config.read_text(encoding="utf-8")
    upstream_config = (
        args.upstream_config.read_text(encoding="utf-8")
        if args.upstream_config
        else None
    )
    merged = merge_slices(
        config,
        read_slices(args.slice_dir),
        upstream_config=upstream_config,
        reset_slices=args.reset_slice,
    )
    output.write_text(merged, encoding="utf-8")


if __name__ == "__main__":
    main()
