"""Refresh repository-owned binary versions and all supported platform hashes"""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

GITHUB_SHA256_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def replace_once(pattern, replacement, content):
    result, count = re.subn(pattern, lambda _: replacement, content)
    if count != 1:
        raise ValueError(f"Expected one pin matching {pattern!r}, found {count}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", choices=["bun", "helium-darwin"])
    parser.add_argument("--version")
    args = parser.parse_args()

    environment = os.environ.copy()
    if not environment.get("GH_TOKEN") and environment.get("RENOVATE_TOKEN"):
        environment["GH_TOKEN"] = environment["RENOVATE_TOKEN"]
    if args.package == "bun":
        path = Path("nix/overlays/upstream/upstream.nix")
        repository, prefix = "oven-sh/bun", "bun-v"
        start, end = "  bun = ", "\n  solaar ="
        assets = {
            "aarch64-darwin": "bun-darwin-aarch64.zip",
            "aarch64-linux": "bun-linux-aarch64.zip",
            "x86_64-linux": "bun-linux-x64-baseline.zip",
        }
    else:
        path = Path("nix/overlays/applications.nix")
        repository, prefix = "imputnet/helium-macos", ""
        start, end = "  heliumDarwin = ", "\n  hostGraphics ="
        assets = {"aarch64-darwin": "helium_{version}_arm64-macos.dmg"}

    content = path.read_text()
    if content.count(start) != 1 or content.count(end) != 1:
        raise ValueError(f"Cannot locate the owned {args.package} override")
    before, section = content.split(start, 1)
    section, after = section.split(end, 1)
    current = re.findall(r'version = "([^"]+)";', section)
    if len(current) != 1:
        raise ValueError("Expected one version in the owned override")
    version = current[0] if args.version == "skip" else args.version
    endpoint = "latest" if version is None else f"tags/{prefix}{version}"
    release = json.loads(
        subprocess.run(
            ["gh", "api", f"repos/{repository}/releases/{endpoint}"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            env=environment,
        ).stdout
    )
    tag = release["tag_name"]
    if not tag.startswith(prefix):
        raise ValueError(f"Unexpected release tag: {tag}")
    if version is None:
        version = tag[len(prefix) :]
    elif tag != f"{prefix}{version}":
        raise ValueError(f"Release tag does not match selected version: {tag}")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", version):
        raise ValueError(f"Unexpected binary release version: {version}")

    section = replace_once(r'version = "[^"]+";', f'version = "{version}";', section)
    for platform, asset in assets.items():
        filename = asset.format(version=version)
        matches = [entry for entry in release["assets"] if entry["name"] == filename]
        if len(matches) != 1:
            raise ValueError(f"Expected one release asset named {filename}")
        digest = matches[0].get("digest") or ""
        if GITHUB_SHA256_DIGEST.fullmatch(digest):
            raw_hash = bytes.fromhex(digest.removeprefix("sha256:"))
        else:
            # The release API avoids GitHub's unreliable browser download route
            with tempfile.TemporaryDirectory(prefix="dotfiles-binary-") as staging:
                archive = Path(staging) / filename
                subprocess.run(
                    [
                        "gh",
                        "release",
                        "download",
                        tag,
                        "--repo",
                        repository,
                        "--pattern",
                        filename,
                        "--output",
                        str(archive),
                    ],
                    check=True,
                    env=environment,
                )
                with archive.open("rb") as source:
                    raw_hash = hashlib.file_digest(source, "sha256").digest()
        hash_value = "sha256-" + base64.b64encode(raw_hash).decode()
        if args.package == "bun":
            pattern = rf'{re.escape(platform)} = "sha256-[^"]+";'
            replacement = f'{platform} = "{hash_value}";'
        else:
            pattern = r'hash = "sha256-[^"]+";'
            replacement = f'hash = "{hash_value}";'
        section = replace_once(pattern, replacement, section)

    updated = before + start + section + end + after
    if updated == content:
        return
    with tempfile.NamedTemporaryFile(
        "w", prefix=f".{path.name}.", dir=path.parent, delete_on_close=False
    ) as output:
        output.write(updated)
        output.close()
        os.chmod(output.name, path.stat().st_mode)
        os.replace(output.name, path)


if __name__ == "__main__":
    main()
