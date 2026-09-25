import json
import os
import shutil
import subprocess
from pathlib import Path

from workstation.lib.files import write_if_changed


def remove_owned(path: Path) -> None:
    if path.is_file() or path.is_symlink():
        path.unlink()


def capture(command: tuple[str, ...], target: Path, shell: str) -> None:
    executable = shutil.which(command[0])
    if executable is None:
        remove_owned(target)
        return
    result = subprocess.run(
        (executable, *command[1:]),
        check=False,
        capture_output=True,
        env={**os.environ, "SHELL": f"/bin/{shell}"},
        text=True,
    )
    if result.returncode != 0:
        print(f"failed to generate shell integration for {command[0]}")
        return
    write_if_changed(target, result.stdout)


def main() -> None:
    home = Path(os.environ["CHEZMOI_HOME_DIR"])
    cache = Path(os.environ.get("XDG_CACHE_HOME", home / ".cache"))
    data = Path(os.environ.get("XDG_DATA_HOME", home / ".local/share"))
    extra_commands_path = home / ".config/shell/completion-commands.json"
    extra_commands = (
        tuple(
            (name, tuple(command))
            for name, command in json.loads(extra_commands_path.read_text()).items()
        )
        if extra_commands_path.is_file()
        else ()
    )
    for shell in ("zsh", "bash"):
        completion_dir = (
            cache / "zsh/completions"
            if shell == "zsh"
            else data / "bash-completion/completions"
        )
        completion_dir.mkdir(parents=True, exist_ok=True)
        prefix = "_" if shell == "zsh" else ""
        for name, command in extra_commands:
            capture(
                tuple(part.format(shell=shell) for part in command),
                completion_dir / f"{prefix}{name}",
                shell,
            )
