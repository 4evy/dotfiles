"""Install the pinned Astral sources into Spectrum's Python vendor directory."""

import json
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory

from source_lock import download_file


def main() -> None:
    pin = json.loads(Path("/src/sources.json").read_text(encoding="utf-8"))["pins"][
        "python-astral"
    ]
    with TemporaryDirectory() as temporary_directory:
        temporary_path = Path(temporary_directory)
        archive = temporary_path / "astral.tar.gz"
        download_file(pin, archive)
        with tarfile.open(archive) as source_archive:
            source_archive.extractall(temporary_path, filter="data")
        source = next(temporary_path.glob("astral-*/src/astral"))
        destination = Path("/out/usr/lib/dotfiles/python/astral")
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.copy(destination, preserve_metadata=True)
        version = source.parents[1].name.removeprefix("astral-")
        (destination.parent / ".astral-version").write_text(
            f"{version}\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
