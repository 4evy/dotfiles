import shutil
from pathlib import Path

DNF_CLEANUP_PATTERNS = (
    "/run/dnf",
    "/var/cache/ldconfig/aux-cache",
    "/var/lib/dnf/repos",
    "/var/lib/dnf/system-repo.lock",
    "/var/lib/sepolgen",
    "/var/log/dnf*",
    "/var/log/hawkey.log",
    "/var/tmp/*",
)


def cleanup_paths() -> None:
    for path in (
        path
        for pattern in DNF_CLEANUP_PATTERNS
        for path in Path("/").glob(pattern.removeprefix("/"))
    ):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
