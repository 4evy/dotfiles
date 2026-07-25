"""Chezmoi lifecycle hooks for shell and editor integrations."""

import os
from pathlib import Path

from workstation.console import error_console
from workstation.lib.commands import run, which
from workstation.lib.files import ensure_directory, write_if_changed
from workstation.lib.host import user_cache_home

_SHELL_TOOLS = ("atuin", "broot", "fzf", "starship", "zoxide")
_COMPLETION_COMMANDS = (
    ("chezmoi", ("chezmoi", "completion", "{shell}")),
    ("jj", ("jj", "util", "completion", "{shell}")),
    ("starship", ("starship", "completions", "{shell}")),
    ("deno", ("deno", "completions", "{shell}")),
    ("delta", ("delta", "--generate-completion", "{shell}")),
    ("rustup", ("rustup", "completions", "{shell}")),
    ("cargo", ("rustup", "completions", "{shell}", "cargo")),
)


def _extensions(path: Path) -> list[str]:
    return [
        value
        for line in path.read_text(encoding="utf-8").splitlines()
        if (value := line.split("#", 1)[0].strip())
    ]


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


def yazi_init() -> None:
    """Install the Yazi plugins declared in package.toml."""
    if which("ya") is None:
        error_console.print("Yazi plugin install skipped: ya not found")
        return
    xdg_config_home = os.environ.get("XDG_CONFIG_HOME")
    config = (
        Path(xdg_config_home) if xdg_config_home else Path.home() / ".config"
    ) / "yazi"
    if not (config / "package.toml").is_file():
        error_console.print(
            f"Yazi plugin install skipped: {config / 'package.toml'} not found"
        )
        return
    run(
        ("ya", "pkg", "install", "--discard"),
        env={"YAZI_CONFIG_HOME": os.fspath(config)},
    )


def _capture(
    command: tuple[str, ...], target: Path, *, portable_executable: bool = False
) -> None:
    executable = which(command[0])
    if executable is None:
        return
    result = run(command, check=False, capture=True)
    if result.returncode == 0:
        content = result.stdout
        if portable_executable:
            content = content.replace(os.fspath(executable), command[0])
        write_if_changed(target, content)
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


def _completion_command(command: tuple[str, ...], shell: str) -> tuple[str, ...]:
    return tuple(part.format(shell=shell) for part in command)


def shell_init() -> None:
    """Cache shell integrations and completion scripts."""
    cache = user_cache_home()
    for name in _SHELL_TOOLS:
        ensure_directory(cache / name)
    for shell in ("zsh", "bash"):
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
        _capture(
            ("broot", "--print-shell-function", shell),
            cache / f"broot/init.{shell}",
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
        for name, command in _COMPLETION_COMMANDS:
            _capture(
                _completion_command(command, shell),
                completion_dir / f"{prefix}{name}",
            )
