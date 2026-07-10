from __future__ import annotations

import os
import sys
from importlib import import_module
from pathlib import Path

import typer

from workstation.apps.discord import main as discord_main
from workstation.console import error_console
from workstation.lib.commands import run, which
from workstation.lib.files import ensure_directory, write_if_changed
from workstation.lib.host import user_cache_home, user_config_home
from workstation.lib.paths import find_repo_root
from workstation.local.raycast import main as raycast_patch
from workstation.local.user_commands import (
    _gnome_accent_apply,
    alt_tab_license_entrypoint,
    shottr_license_entrypoint,
)

app = typer.Typer(no_args_is_help=True, pretty_exceptions_enable=False)


@app.command("alt-tab-license")
def alt_tab_license() -> None:
    """Show the installed AltTab license state."""
    original = sys.argv
    try:
        sys.argv = [original[0], "status"]
        alt_tab_license_entrypoint()
    finally:
        sys.argv = original


@app.command("shottr-license")
def shottr_license(action: str = typer.Argument("status")) -> None:
    """Install or show the Shottr license state."""
    original = sys.argv
    try:
        sys.argv = [original[0], action]
        shottr_license_entrypoint()
    finally:
        sys.argv = original


@app.command("raycast-beta-patch")
def raycast_beta_patch() -> None:
    """Refresh the Raycast Beta local user profile."""
    raycast_patch()


@app.command("gnome-accent")
def gnome_accent() -> None:
    """Refresh Catppuccin GTK accent CSS and its user service."""
    _gnome_accent_apply()
    if which("systemctl") is not None:
        run(("systemctl", "--user", "daemon-reload"), check=False, capture=True)
        run(
            (
                "systemctl",
                "--user",
                "enable",
                "--now",
                "gnome-catppuccin-accent.service",
            ),
            check=False,
            capture=True,
        )


@app.command("desktop-integrations")
def desktop_integrations() -> None:
    """Apply the desktop-related subset of the Ansible host playbook."""
    source = Path(
        os.environ.get("CHEZMOI_SOURCE_DIR", Path.home() / "nix-dotfiles/dotfiles")
    )
    try:
        repository = find_repo_root(source)
    except FileNotFoundError:
        error_console.print(
            f"chezmoi desktop integrations skipped: could not find repo root from {source}"
        )
        return
    ansible = which("ansible-playbook")
    if ansible is not None:
        command: tuple[str | os.PathLike[str], ...] = (ansible,)
    elif (uvx := which("uvx")) is not None:
        command = (uvx, "--from", "ansible-core", "ansible-playbook")
    else:
        error_console.print(
            "chezmoi desktop integrations skipped: ansible-playbook/uvx not found"
        )
        return
    run(
        (
            *command,
            "ansible/playbooks/host.yml",
            "--tags",
            "always,hyper-window-tiling,sushi-preview,telegram-flatpak,emoji-shortcut",
        ),
        cwd=repository,
    )


@app.command("discord-equicord")
def discord_equicord() -> None:
    """Repair Equicord after Discord replaces its application bundle."""
    returncode = discord_main(["--repair-only"])
    if returncode != 0:
        raise typer.Exit(returncode)


def _extensions(path: Path) -> list[str]:
    result: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = line.split("#", 1)[0].strip()
        if value:
            result.append(value)
    return result


@app.command("vscode-extensions")
def vscode_extensions() -> None:
    """Install configured VS Code extensions that are currently missing."""
    if which("code") is None:
        return
    source = Path(
        os.environ.get("CHEZMOI_SOURCE_DIR", Path.home() / "nix-dotfiles/dotfiles")
    )
    configured = source / "dot_config/Code/User/vscode-extensions.txt"
    if not configured.is_file():
        return
    installed = {
        line.casefold()
        for line in run(("code", "--list-extensions"), capture=True).stdout.splitlines()
    }
    for extension in _extensions(configured):
        if extension.casefold() not in installed:
            run(("code", "--install-extension", extension, "--force"))


@app.command("yazi-init")
def yazi_init() -> None:
    """Install the Yazi plugins declared in package.toml."""
    if which("ya") is None:
        error_console.print("Yazi plugin install skipped: ya not found")
        return
    config = user_config_home() / "yazi"
    if not (config / "package.toml").is_file():
        error_console.print(
            f"Yazi plugin install skipped: {config / 'package.toml'} not found"
        )
        return
    run(
        ("ya", "pkg", "install", "--discard"),
        env={"YAZI_CONFIG_HOME": os.fspath(config)},
    )


def _capture(command: tuple[str, ...], target: Path) -> None:
    if which(command[0]) is None:
        return
    result = run(command, check=False, capture=True)
    if result.returncode == 0:
        write_if_changed(target, result.stdout)
    else:
        error_console.print(f"failed to generate shell init for {command[0]}")


def _fzf_zsh(target: Path) -> None:
    if which("fzf") is None:
        return
    result = run(("fzf", "--zsh"), check=False, capture=True)
    if result.returncode != 0:
        return
    content = result.stdout.split("### completion.zsh ###", 1)[0]
    marker = "  eval $__fzf_key_bindings_options"
    replacement = (
        "  __fzf_key_bindings_options=${__fzf_key_bindings_options/ zle on/}\n"
        "  __fzf_key_bindings_options=${__fzf_key_bindings_options/ zle off/}\n"
        + marker
    )
    write_if_changed(target, content.replace(marker, replacement))


@app.command("shell-init")
def shell_init() -> None:
    """Cache shell integrations and completion scripts."""
    cache = user_cache_home()
    for shell in ("zsh", "bash"):
        for name in ("fzf", "starship", "zoxide", "atuin"):
            ensure_directory(cache / name)
        completion_dir = ensure_directory(cache / shell / "completions")
        if shell == "zsh":
            _fzf_zsh(cache / "fzf/init.zsh")
        else:
            _capture(("fzf", "--bash"), cache / "fzf/init.bash")
        _capture(("starship", "init", shell), cache / f"starship/init.{shell}")
        zoxide = (
            ("zoxide", "init", shell, "--cmd", "cd")
            if shell == "bash"
            else ("zoxide", "init", shell)
        )
        _capture(zoxide, cache / f"zoxide/init.{shell}")
        _capture(
            ("atuin", "init", shell, "--disable-up-arrow"),
            cache / f"atuin/init.{shell}",
        )
        if which("atuin") is not None:
            run(
                (
                    "atuin",
                    "gen-completions",
                    "--shell",
                    shell,
                    "--out-dir",
                    completion_dir,
                ),
                check=False,
            )
        prefix = "_" if shell == "zsh" else ""
        completions = (
            ("chezmoi", ("chezmoi", "completion", shell)),
            ("jj", ("jj", "util", "completion", shell)),
            ("zellij", ("zellij", "setup", "--generate-completion", shell)),
            ("starship", ("starship", "completions", shell)),
            ("deno", ("deno", "completions", shell)),
            ("delta", ("delta", "--generate-completion", shell)),
            ("rustup", ("rustup", "completions", shell)),
            ("cargo", ("rustup", "completions", shell, "cargo")),
        )
        for name, command in completions:
            _capture(command, completion_dir / f"{prefix}{name}")


@app.command("terminal-profile")
def terminal_profile() -> None:
    """Install the Catppuccin Frappé Pink profile in Terminal.app."""
    if sys.platform != "darwin":
        return
    appkit = import_module("AppKit")
    foundation = import_module("Foundation")
    ns_color = getattr(appkit, "NSColor")
    ns_font = getattr(appkit, "NSFont")
    ns_keyed_archiver = getattr(foundation, "NSKeyedArchiver")
    ns_user_defaults = getattr(foundation, "NSUserDefaults")

    def archived(value: object) -> object:
        return ns_keyed_archiver.archivedDataWithRootObject_(value)

    def color(value: str) -> object:
        return archived(
            ns_color.colorWithSRGBRed_green_blue_alpha_(
                int(value[1:3], 16) / 255,
                int(value[3:5], 16) / 255,
                int(value[5:7], 16) / 255,
                1,
            )
        )

    name = "Catppuccin Frappé Pink"
    font = ns_font.fontWithName_size_("JetBrainsMonoNerdFontMono-Regular", 15)
    if font is None:
        font = ns_font.monospacedSystemFontOfSize_weight_(15, 0)

    profile: dict[str, object] = {
        "name": name,
        "type": "Window Settings",
        "ProfileCurrentVersion": 2.09,
        "columnCount": 120,
        "rowCount": 30,
        "Font": archived(font),
        "FontAntialias": True,
        "FontHeightSpacing": 1,
        "FontWidthSpacing": 1,
        "BackgroundBlur": 0,
        "BackgroundBlurInactive": 0,
        "BackgroundSettingsForInactiveWindows": False,
        "DynamicANSIForegroundColors": False,
        "TextColor": color("#c6d0f5"),
        "TextBoldColor": color("#f4b8e4"),
        "BackgroundColor": color("#303446"),
        "CursorColor": color("#f4b8e4"),
        "SelectionColor": color("#51576d"),
    }
    ansi = (
        "#51576d",
        "#e78284",
        "#a6d189",
        "#e5c890",
        "#8caaee",
        "#f4b8e4",
        "#81c8be",
        "#a5adce",
        "#626880",
        "#e78284",
        "#a6d189",
        "#e5c890",
        "#8caaee",
        "#f4b8e4",
        "#81c8be",
        "#b5bfe2",
    )
    keys = (
        "ANSIBlackColor",
        "ANSIRedColor",
        "ANSIGreenColor",
        "ANSIYellowColor",
        "ANSIBlueColor",
        "ANSIMagentaColor",
        "ANSICyanColor",
        "ANSIWhiteColor",
        "ANSIBrightBlackColor",
        "ANSIBrightRedColor",
        "ANSIBrightGreenColor",
        "ANSIBrightYellowColor",
        "ANSIBrightBlueColor",
        "ANSIBrightMagentaColor",
        "ANSIBrightCyanColor",
        "ANSIBrightWhiteColor",
    )
    profile.update({key: color(value) for key, value in zip(keys, ansi, strict=True)})
    defaults = ns_user_defaults.standardUserDefaults()
    domain = dict(defaults.persistentDomainForName_("com.apple.Terminal") or {})
    settings = dict(domain.get("Window Settings") or {})
    settings[name] = profile
    domain.update({
        "Window Settings": settings,
        "Default Window Settings": name,
        "Startup Window Settings": name,
        "DefaultProfilesVersion": 2,
        "ProfileCurrentVersion": 2.09,
    })
    defaults.setPersistentDomain_forName_(domain, "com.apple.Terminal")
