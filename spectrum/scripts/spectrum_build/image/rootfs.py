from __future__ import annotations

import shutil
from pathlib import Path

from spectrum_build.core.common import require_readable_file


ROOTFS_DIR = "image/rootfs"


def install_rootfs_files(context_dir: Path) -> None:
    rootfs = context_dir / ROOTFS_DIR
    if rootfs.exists():
        shutil.copytree(rootfs, Path("/"), dirs_exist_ok=True)


def validate_rootfs_files(context_dir: Path) -> None:
    rootfs = context_dir / ROOTFS_DIR
    if not rootfs.exists():
        return

    for source in sorted(path for path in rootfs.rglob("*") if path.is_file()):
        require_readable_file(Path("/") / source.relative_to(rootfs))
