from pathlib import Path

from spectrum_build.core.common import fail

PACKAGE_MANIFEST = Path(__file__).parents[3] / "image" / "packages" / "required.txt"


def required_packages(path: Path = PACKAGE_MANIFEST) -> tuple[str, ...]:
    """Return the validated package manifest in deterministic install order."""
    try:
        packages = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"cannot read Fedora package manifest: {path}: {error}")

    if not packages:
        fail(f"Fedora package manifest is empty: {path}")
    if packages != sorted(set(packages)):
        fail(f"Fedora package manifest must be sorted and unique: {path}")
    if any(not package or package != package.strip() for package in packages):
        fail(f"Fedora package manifest contains an invalid line: {path}")
    return tuple(packages)


def validate_package_manifest(path: Path = PACKAGE_MANIFEST) -> None:
    required_packages(path)
