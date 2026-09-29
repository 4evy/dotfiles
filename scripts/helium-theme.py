#!/usr/bin/env python3
"""Build and install the Catppuccin Custom theme for Helium."""

import argparse
import hashlib
import json
import pathlib
import struct
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
PALETTE = (
    ROOT / "packages/dotfiles-python/assets/desktop/catppuccin_custom_palette.json"
)
THEME = ROOT / "browser/catppuccin-custom-theme"
INSTALLED_THEME = pathlib.Path.home() / ".cache/dotfiles/helium/catppuccin-custom-theme"


def rgb(value: str) -> list[int]:
    return list(bytes.fromhex(value.removeprefix("#")))


def build() -> None:
    palette_bytes = PALETTE.read_bytes()
    dark = json.loads(palette_bytes)["catppuccin_custom"]["dark"]
    version_parts = struct.unpack(">3H", hashlib.sha256(palette_bytes).digest()[:6])
    colors = {
        "frame": "sidebar",
        "frame_inactive": "sidebar",
        "background_tab": "sidebar",
        "background_tab_inactive": "sidebar",
        "toolbar": "toolbar",
        "toolbar_text": "toolbarForeground",
        "toolbar_button_icon": "accent",
        "bookmark_text": "toolbarForeground",
        "tab_text": "accent",
        "tab_background_text": "textMuted",
        "tab_background_text_inactive": "textMuted",
        "omnibox_background": "input",
        "omnibox_text": "text",
        "ntp_background": "canvas",
        "ntp_text": "text",
        "ntp_link": "blue",
        "ntp_header": "accent",
        "button_background": "input",
    }
    manifest = {
        "manifest_version": 3,
        "name": "Catppuccin Custom Dark",
        "version": "1." + ".".join(map(str, version_parts)),
        "description": "Catppuccin Custom colors for Helium",
        "theme": {"colors": {key: rgb(dark[role]) for key, role in colors.items()}},
    }
    THEME.mkdir(exist_ok=True)
    (THEME / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    INSTALLED_THEME.mkdir(parents=True, exist_ok=True)
    (THEME / "manifest.json").copy(INSTALLED_THEME / "manifest.json")
    (INSTALLED_THEME / "Cached Theme.pak").unlink(missing_ok=True)


def install(platform: str, profile: pathlib.Path, browser: pathlib.Path) -> None:
    if platform == "macos":
        subprocess.run(
            ["open", "-a", "Helium", "--args", f"--load-extension={INSTALLED_THEME}"],
            check=True,
        )
    else:
        process = subprocess.Popen(
            [str(browser), f"--load-extension={INSTALLED_THEME}"]
        )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                prefs = json.loads((profile / "Preferences").read_text())
                theme = prefs.get("extensions", {}).get("theme", {})
                if (
                    theme.get("pack") == str(INSTALLED_THEME)
                    and (INSTALLED_THEME / "Cached Theme.pak").exists()
                ):
                    return
            except FileNotFoundError, json.JSONDecodeError:
                pass
            time.sleep(0.5)
        raise RuntimeError("Helium did not activate the Catppuccin Custom theme")
    finally:
        if platform == "macos":
            subprocess.run(
                ["osascript", "-e", 'tell application "Helium" to quit'], check=True
            )
        else:
            process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=("macos", "linux"))
    parser.add_argument("profile", type=pathlib.Path)
    parser.add_argument("--browser", required=True, type=pathlib.Path)
    args = parser.parse_args()
    build()
    install(args.platform, args.profile, args.browser)
