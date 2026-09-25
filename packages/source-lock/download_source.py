"""Download a named file input from a projected flake lock."""

import argparse
import json
from pathlib import Path

from source_lock import download_file


def main() -> None:
    parser = argparse.ArgumentParser(suggest_on_error=True)
    parser.add_argument("lock", type=Path)
    parser.add_argument("name")
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    pin = json.loads(args.lock.read_text(encoding="utf-8"))["pins"][args.name]
    download_file(pin, args.destination)


if __name__ == "__main__":
    main()
