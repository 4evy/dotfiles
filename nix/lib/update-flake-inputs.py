"""Update package-owning inputs, advancing explicit GitHub revision pins too"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GIT_SHA1_REVISION = re.compile(r"[0-9a-f]{40}")


def main():
    names = sys.argv[1:]
    if not names:
        raise ValueError("At least one owning input is required")
    flake = Path("flake.nix").read_text()
    lock = json.loads(Path("flake.lock").read_text())
    inputs = lock["nodes"][lock["root"]]["inputs"]
    for name in names:
        original = lock["nodes"][inputs[name]]["original"]
        revision = original.get("rev", "")
        if original["type"] != "github" or not GIT_SHA1_REVISION.fullmatch(revision):
            continue
        repository = f"{original['owner']}/{original['repo']}"
        refs = subprocess.run(
            ["git", "ls-remote", f"https://github.com/{repository}.git", "HEAD"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout.split()
        if len(refs) != 2 or not GIT_SHA1_REVISION.fullmatch(refs[0]):
            raise ValueError(f"Cannot discover the default-branch revision for {name}")
        old = f'"github:{repository}/{revision}"'
        new = f'"github:{repository}/{refs[0]}"'
        if flake.count(old) != 1:
            raise ValueError(f"Expected one owning URL for {name}")
        flake = flake.replace(old, new, 1)

    # Publish the URL and lock together only after the new inputs resolve
    with tempfile.TemporaryDirectory(prefix="dotfiles-inputs-") as staging:
        directory = Path(staging)
        (directory / "flake.nix").write_text(flake)
        shutil.copyfile("flake.lock", directory / "flake.lock")
        subprocess.run(
            ["nix", "flake", "update", "--flake", staging, *names], check=True
        )
        shutil.copyfile(directory / "flake.nix", "flake.nix")
        shutil.copyfile(directory / "flake.lock", "flake.lock")


if __name__ == "__main__":
    main()
