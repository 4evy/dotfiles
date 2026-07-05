#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path

from spectrum_build.image.formatting import format_bytes, tree_size


DEFAULT_MAX_INITRAMFS_BYTES = 300 * 1024 * 1024


def report_files(label: str, files: list[Path]) -> int:
    print(f"{label}:")
    if not files:
        print("  none")
        return 0

    largest = 0
    for path in files:
        size = path.stat().st_size
        largest = max(largest, size)
        print(f"  {format_bytes(size):>10}  {path}")
    return largest


def main() -> int:
    max_initramfs = int(
        os.environ.get("SPECTRUM_MAX_INITRAMFS_BYTES", DEFAULT_MAX_INITRAMFS_BYTES)
    )

    initramfs_files = sorted(Path("/boot").glob("**/initramfs-*.img"))
    kernel_files = sorted(Path("/boot").glob("**/vmlinuz-*"))
    module_dirs = sorted(Path("/usr/lib/modules").glob("*"))

    largest_initramfs = report_files("boot initramfs images", initramfs_files)
    report_files("boot kernels", kernel_files)

    print("kernel module trees:")
    if module_dirs:
        for module_dir in module_dirs:
            if module_dir.is_dir():
                print(f"  {format_bytes(tree_size(module_dir)):>10}  {module_dir}")
    else:
        print("  none")

    if largest_initramfs > max_initramfs:
        print(
            "error: largest initramfs is "
            f"{format_bytes(largest_initramfs)}, above "
            f"{format_bytes(max_initramfs)}",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
