#!/usr/bin/env python3.14
import json
import os
import select
import shutil
import sqlite3
import subprocess
import sys
import time
import tomllib
from collections.abc import Iterable
from pathlib import Path


def first_executable(
    candidates: Iterable[str | os.PathLike[str] | None],
    *,
    excluding: Path | None = None,
) -> Path | None:
    return next(
        (
            path
            for value in candidates
            if value is not None
            for path in (Path(value),)
            if (excluding is None or path.resolve() != excluding)
            and path.is_file()
            and os.access(path, os.X_OK)
        ),
        None,
    )


def project_root(path: Path, git: str | None) -> Path:
    path = path.resolve()
    if not path.is_dir():
        return path
    project = path
    if git is not None:
        root = subprocess.run(
            [git, "-C", os.fspath(path), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
        )
        if root.returncode == 0:
            project = Path(root.stdout.strip()).resolve()
    return project


def launch_paths(home: Path) -> list[Path]:
    paths = [Path.cwd()]
    if "agents" in sys.argv[1:]:
        database = home / ".codex/state_5.sqlite"
        if database.is_file():
            try:
                with sqlite3.connect(
                    f"file:{database}?mode=ro", uri=True
                ) as connection:
                    paths.extend(
                        Path(cwd)
                        for (cwd,) in connection.execute(
                            "SELECT DISTINCT cwd FROM threads WHERE archived = 0"
                        )
                        if Path(cwd).is_dir()
                    )
            except sqlite3.Error:
                pass
    return paths


def trust_launch_projects(real: Path, home: Path) -> None:
    git = shutil.which("git")
    projects = {project_root(path, git) for path in launch_paths(home)}
    config_path = home / ".codex/config.toml"
    with config_path.open("rb") as config_file:
        config = tomllib.load(config_file)
    untrusted = [
        project
        for project in sorted(projects)
        if config.get("projects", {}).get(os.fspath(project), {}).get("trust_level")
        != "trusted"
    ]
    if not untrusted:
        return

    server = subprocess.Popen(
        [os.fspath(real), "app-server", "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        if server.stdin is None or server.stdout is None:
            raise RuntimeError("Codex config writer has no input or output stream")
        requests = [
            ("initialize", {"clientInfo": {"name": "codex-launcher", "version": "1"}})
        ]
        requests.extend(
            (
                "config/value/write",
                {
                    "keyPath": f"projects.{json.dumps(os.fspath(project))}.trust_level",
                    "mergeStrategy": "upsert",
                    "value": "trusted",
                },
            )
            for project in untrusted
        )
        for identifier, (method, params) in enumerate(requests, start=1):
            server.stdin.write(
                json.dumps({
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "method": method,
                    "params": params,
                })
                + "\n"
            )
            server.stdin.flush()
            deadline = time.monotonic() + 5
            while True:
                remaining = deadline - time.monotonic()
                if (
                    remaining <= 0
                    or not select.select([server.stdout], [], [], remaining)[0]
                ):
                    raise TimeoutError("Codex config write timed out")
                line = server.stdout.readline()
                if not line:
                    raise RuntimeError("Codex config writer exited")
                response = json.loads(line)
                if response.get("id") == identifier:
                    break
            if "error" in response:
                raise RuntimeError(response["error"])
    finally:
        if server.poll() is None:
            server.terminate()
        server.wait(timeout=3)


wrapper = Path(sys.argv[0]).resolve()
home = Path.home()
candidates = [
    os.environ.get("CODEX_REAL_BIN"),
    home / ".bun/bin/codex",
    Path("/opt/homebrew/bin/codex"),
    Path("/home/linuxbrew/.linuxbrew/bin/codex"),
    Path("/usr/local/bin/codex"),
    Path("/usr/bin/codex"),
    *(Path(directory) / "codex" for directory in os.get_exec_path()),
]
real = first_executable(candidates, excluding=wrapper)
if real is None:
    raise SystemExit("codex: real Codex binary not found")

if sys.stdin.isatty() and sys.stdout.isatty():
    try:
        trust_launch_projects(real, home)
    except (OSError, RuntimeError, TimeoutError, ValueError, sqlite3.Error) as exc:
        raise SystemExit(f"codex: could not trust launch projects: {exc}") from exc

# Both cx and direct Codex launches use this wrapper. Update the syntax theme
# in the config file so CLI overrides do not disable the shared server.
theme_helper = home / ".local/libexec/codex-theme-defaults"
if theme_helper.is_file() and sys.stdin.isatty() and sys.stdout.isatty():
    subprocess.run([sys.executable, theme_helper, real], check=False)

# Evy opts into running enabled hooks without per-definition trust prompts.
os.execv(real, [os.fspath(real), "--dangerously-bypass-hook-trust", *sys.argv[1:]])
