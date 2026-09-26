#!/usr/bin/env python3.14
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tomllib
from collections.abc import AsyncIterator, Iterable, Iterator, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path


def first_executable(
    candidates: Iterable[str | os.PathLike[str] | None],
    *,
    excluding: Path | None = None,
) -> Path | None:
    for candidate in candidates:
        if candidate is None:
            continue
        executable = shutil.which(os.fspath(candidate))
        if executable is not None:
            path = Path(executable)
            if excluding is None or path.resolve() != excluding:
                return path
    return None


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


@dataclass
class AppServer:
    process: asyncio.subprocess.Process
    identifiers: Iterator[int] = field(default_factory=lambda: count(1))

    async def send(self, payload: Mapping[str, object]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("Codex app server has no input stream")
        self.process.stdin.write(json.dumps(payload).encode() + b"\n")
        await self.process.stdin.drain()

    async def request(self, method: str, params: Mapping[str, object]) -> object:
        identifier = next(self.identifiers)
        try:
            async with asyncio.timeout(5):
                await self.send({
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "method": method,
                    "params": params,
                })
                return await self.receive(identifier)
        except TimeoutError as exc:
            raise TimeoutError(f"Codex {method} response timed out") from exc

    async def receive(self, identifier: int) -> object:
        if self.process.stdout is None:
            raise RuntimeError("Codex app server has no output stream")
        async for line in self.process.stdout:
            payload: object = json.loads(line)
            response = payload if isinstance(payload, dict) else {}
            if "method" in response or response.get("id") != identifier:
                continue
            if "error" in response:
                raise RuntimeError(response["error"])
            return response.get("result")
        raise RuntimeError("Codex app server exited")


@asynccontextmanager
async def app_server(real: Path) -> AsyncIterator[AppServer]:
    process = await asyncio.create_subprocess_exec(
        real,
        "app-server",
        "--stdio",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=16 * 1024 * 1024,
    )
    try:
        server = AppServer(process)
        await server.request(
            "initialize",
            {"clientInfo": {"name": "codex-launcher", "version": "1"}},
        )
        async with asyncio.timeout(5):
            await server.send({"jsonrpc": "2.0", "method": "initialized"})
        yield server
    finally:
        with suppress(ProcessLookupError):
            process.terminate()
        try:
            async with asyncio.timeout(3):
                await process.communicate()
        except TimeoutError:
            with suppress(ProcessLookupError):
                process.kill()
            await process.communicate()


async def launch_paths(server: AppServer) -> set[Path]:
    paths = {Path.cwd()}
    cursor: str | None = None
    seen_cursors: set[str] = set()
    while True:
        result = await server.request(
            "thread/list",
            {
                "archived": False,
                "cursor": cursor,
                "limit": 100,
                "modelProviders": [],
                "sourceKinds": [
                    "cli",
                    "vscode",
                    "exec",
                    "appServer",
                    "subAgent",
                    "unknown",
                ],
                "useStateDbOnly": True,
            },
        )
        page_paths, next_cursor = parse_thread_page(result)
        paths.update(page_paths)
        if next_cursor is None:
            return paths
        if next_cursor in seen_cursors:
            raise RuntimeError("Codex thread/list repeated a pagination cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor


def parse_thread_page(result: object) -> tuple[list[Path], str | None]:
    if not isinstance(result, dict):
        raise TypeError("Codex thread/list returned an invalid response")
    data = result.get("data")
    if not isinstance(data, list):
        raise TypeError("Codex thread/list returned an invalid response")
    cursor = result.get("nextCursor")
    if cursor is not None and not isinstance(cursor, str):
        raise TypeError("Codex thread/list returned an invalid cursor")
    paths = []
    for thread in data:
        if not isinstance(thread, dict):
            continue
        cwd = thread.get("cwd")
        if isinstance(cwd, str) and (path := Path(cwd)).is_absolute():
            paths.append(path)
    return paths, cursor


async def trust_launch_projects(real: Path, home: Path) -> None:
    git = shutil.which("git")
    config_path = Path(os.environ.get("CODEX_HOME", home / ".codex")) / "config.toml"
    try:
        with config_path.open("rb") as config_file:
            config = tomllib.load(config_file)
    except FileNotFoundError:
        config = {}

    def untrusted_paths(paths: Iterable[Path]) -> list[Path]:
        projects = {project_root(path, git) for path in paths if path.is_dir()}
        return [
            project
            for project in sorted(projects)
            if config.get("projects", {}).get(os.fspath(project), {}).get("trust_level")
            != "trusted"
        ]

    async with app_server(real) as server:
        paths = await launch_paths(server) if "agents" in sys.argv[1:] else {Path.cwd()}
        projects = await asyncio.to_thread(untrusted_paths, paths)
        await trust_projects(server, projects)
        await trust_hooks(server, Path.cwd())


async def trust_projects(server: AppServer, projects: list[Path]) -> None:
    if not projects:
        return
    await server.request(
        "config/batchWrite",
        {
            "edits": [
                {
                    "keyPath": (
                        f"projects.{json.dumps(os.fspath(project), ensure_ascii=False)}"
                        ".trust_level"
                    ),
                    "mergeStrategy": "upsert",
                    "value": "trusted",
                }
                for project in projects
            ],
        },
    )


async def trust_hooks(server: AppServer, cwd: Path) -> None:
    result = await server.request("hooks/list", {"cwds": [os.fspath(cwd)]})
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise TypeError("Codex hooks/list returned an invalid response")
    for entry in result["data"]:
        if not isinstance(entry, dict) or entry.get("cwd") != os.fspath(cwd):
            continue
        if entry.get("errors"):
            raise RuntimeError("Codex hooks/list could not load launch hooks")
        hooks = entry.get("hooks")
        if not isinstance(hooks, list):
            raise TypeError("Codex hooks/list returned invalid hooks")
        trust = {
            hook["key"]: {"trusted_hash": hook["currentHash"]}
            for hook in hooks
            if isinstance(hook, dict)
            and hook.get("trustStatus") in {"untrusted", "modified"}
        }
        if trust:
            await server.request(
                "config/batchWrite",
                {
                    "edits": [
                        {
                            "keyPath": "hooks.state",
                            "mergeStrategy": "upsert",
                            "value": trust,
                        }
                    ],
                    "reloadUserConfig": True,
                },
            )
        return
    raise RuntimeError("Codex hooks/list did not include the launch directory")


def main() -> None:
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

    interactive = sys.stdin.isatty() and sys.stdout.isatty()
    if interactive:
        try:
            asyncio.run(trust_launch_projects(real, home))
        except (
            OSError,
            RuntimeError,
            TimeoutError,
            TypeError,
            ValueError,
            KeyError,
            subprocess.SubprocessError,
        ) as exc:
            raise SystemExit(f"codex: could not trust launch projects: {exc}") from exc

    # Both cx and direct Codex launches use this wrapper. Update the syntax theme
    # in the config file so CLI overrides do not disable the shared server
    theme_helper = home / ".local/libexec/codex-theme-defaults"
    if theme_helper.is_file() and interactive:
        subprocess.run([sys.executable, theme_helper, real], check=False)

    # Hook trust bypass is for automation and forces interactive sessions into
    # embedded mode instead of the shared background server
    hook_trust_flag = [] if interactive else ["--dangerously-bypass-hook-trust"]
    os.execv(real, [os.fspath(real), *hook_trust_flag, *sys.argv[1:]])


if __name__ == "__main__":
    main()
