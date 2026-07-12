from pathlib import Path

from spectrum_build.core.common import fail, require_readable_file

ROOTFS_DIR = "image/rootfs"


def install_rootfs_files(context_dir: Path, root: Path = Path("/")) -> None:
    rootfs = context_dir / ROOTFS_DIR
    if not rootfs.exists():
        return

    for source in sorted(rootfs.rglob("*")):
        destination = root / source.relative_to(rootfs)
        if source.is_dir():
            if destination.is_symlink():
                destination.resolve(strict=False).mkdir(parents=True, exist_ok=True)
            elif destination.exists() and not destination.is_dir():
                fail(f"rootfs destination is not a directory: {destination}")
            else:
                destination.mkdir(parents=True, exist_ok=True)
        elif source.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            source.copy(destination, preserve_metadata=True)
        else:
            fail(f"unsupported rootfs entry type: {source}")


def validate_rootfs_files(context_dir: Path, root: Path = Path("/")) -> None:
    rootfs = context_dir / ROOTFS_DIR
    if not rootfs.exists():
        return

    for source in sorted(path for path in rootfs.rglob("*") if path.is_file()):
        require_readable_file(root / source.relative_to(rootfs))
