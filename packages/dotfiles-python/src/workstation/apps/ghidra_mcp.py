import os
import re
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

from cyclopts import App

from workstation.console import console, error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import output, require_commands, run, which
from workstation.lib.files import (
    ensure_directory,
    install_file_if_changed,
    remove_path,
    require_directory,
    require_file,
    write_if_changed,
)
from workstation.lib.host import user_cache_home, user_data_home
from workstation.lib.paths import asset_path
from workstation.lib.sources import SOURCES
from workstation.lib.templates import render_template
from workstation.lib.validation import safe_path

GHIDRA_MCP_SOURCE = SOURCES.require("ghidra_mcp")
PACKAGE_VERSION = GHIDRA_MCP_SOURCE.require_component("package").require_version()
JAR_VERSION = GHIDRA_MCP_SOURCE.require_component("jar").require_version()
UPSTREAM_REV = GHIDRA_MCP_SOURCE.require_revision()
UPSTREAM_URL = GHIDRA_MCP_SOURCE.repository.clone_url
MCP_SDK_VERSION = GHIDRA_MCP_SOURCE.require_component("mcp_sdk").require_version()
BUILD_STAMP = "19700101-000000"
STATE_VERSION = "1"


def _support_dir() -> Path:
    candidates = (
        os.environ.get("GHIDRA_MCP_INSTALLER_SUPPORT_DIR"),
        asset_path("apps", "ghidra-mcp"),
        user_data_home() / "dotfiles/scripts/ghidra-mcp",
    )
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if (path / "bridge-auth-token.patch").is_file() and (
            path / "wrappers/ghidra-mcp-serve.py.in"
        ).is_file():
            return path
    raise DotfilesError(
        "could not find ghidra-mcp installer support files; "
        "set GHIDRA_MCP_INSTALLER_SUPPORT_DIR"
    )


def _valid_ghidra_home(path: Path) -> bool:
    return (path / "Ghidra/Features").is_dir() and (path / "Ghidra/Framework").is_dir()


def _normalize_ghidra_home(path: Path) -> Path | None:
    expanded = path.expanduser()
    if _valid_ghidra_home(expanded):
        return expanded
    if (
        expanded.name == "Ghidra"
        and (expanded / "Features").is_dir()
        and (expanded / "Framework").is_dir()
    ):
        return expanded.parent
    return None


def _find_named_directories(root: Path, name: str, max_depth: int) -> list[Path]:
    if not root.is_dir():
        return []
    result: list[Path] = []
    base_depth = len(root.parts)
    for path, directories, _files in root.walk():
        depth = len(path.parts) - base_depth
        if depth >= max_depth:
            directories.clear()
        if path.name == name:
            result.append(path)
            directories.clear()
    return result


def _first_ghidra_home(candidates: Iterable[Path]) -> Path | None:
    return next(
        (
            home
            for candidate in candidates
            if (home := _normalize_ghidra_home(candidate)) is not None
        ),
        None,
    )


def detect_ghidra_home() -> Path:
    configured = (
        Path(value)
        for variable in ("GHIDRA_HOME", "GHIDRA_INSTALL_DIR", "GHIDRA_ROOT")
        if (value := os.environ.get(variable))
    )
    if home := _first_ghidra_home(configured):
        return home
    if which("brew") is not None:
        prefix = output(("brew", "--prefix", "ghidra"), check=False)
        candidates = (
            (
                Path(prefix) / suffix
                for suffix in ("libexec", "", "share/ghidra", "ghidra")
            )
            if prefix
            else ()
        )
        if home := _first_ghidra_home(candidates):
            return home
    roots = (
        Path("/opt/homebrew"),
        Path("/usr/local"),
        Path("/home/linuxbrew/.linuxbrew"),
        Path("/Applications"),
        Path.home() / "Applications",
        Path.home() / ".local/share",
        Path("/opt"),
        Path("/usr/share"),
    )
    discovered = (
        directory
        for root in roots
        for directory in _find_named_directories(root, "Ghidra", 7)
    )
    if home := _first_ghidra_home(discovered):
        return home
    raise DotfilesError(
        "could not find Ghidra; pass --ghidra-home PATH where PATH contains Ghidra/"
    )


def ghidra_version(home: Path) -> str:
    for properties in home.glob("*/*/*/application.properties"):
        for line in properties.read_text(errors="replace").splitlines():
            match = re.match(r"\s*application\.version\s*=\s*(\S+)", line)
            if match:
                return match.group(1)
    match = re.search(r"ghidra[_-]([0-9][0-9A-Za-z._-]*)", os.fspath(home))
    if match:
        return match.group(1).split("_PUBLIC", 1)[0]
    raise DotfilesError(f"could not determine Ghidra version from {home}")


def _required_jars(support: Path) -> list[str]:
    return [
        line.strip()
        for line in require_file(support / "required-ghidra-jars.txt")
        .read_text()
        .splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def _verify_jars(home: Path, support: Path) -> None:
    missing = [
        name
        for name in _required_jars(support)
        if not (home / "Ghidra" / name).is_file()
    ]
    if missing:
        raise DotfilesError(
            "Ghidra installation is missing jars required by ghidra-mcp:\n"
            + "\n".join(f"  {name}" for name in missing)
        )


def _java_major() -> int:
    result = run(("java", "-version"), check=False, capture=True)
    text = result.stderr + result.stdout
    match = re.search(r'(?:version "|openjdk )(\d+)(?:\.(\d+))?', text)
    if not match:
        raise DotfilesError("could not determine Java version")
    major = int(match.group(1))
    return int(match.group(2) or major) if major == 1 else major


def _checkout(source: Path) -> None:
    if (source / ".git").is_dir():
        run(("git", "-C", source, "fetch", "--depth", "1", "origin", UPSTREAM_REV))
    else:
        remove_path(source)
        run(("git", "clone", "--no-checkout", UPSTREAM_URL, source))
        run(("git", "-C", source, "fetch", "--depth", "1", "origin", UPSTREAM_REV))
    run(("git", "-C", source, "checkout", "--force", UPSTREAM_REV))
    run(("git", "-C", source, "clean", "-fdx"))
    if output(("git", "-C", source, "rev-parse", "HEAD")) != UPSTREAM_REV:
        raise DotfilesError(f"failed to checkout {UPSTREAM_REV}")


def _logged_run(
    argv: tuple[str | os.PathLike[str], ...],
    log: Path,
    *,
    cwd: Path | None = None,
) -> None:
    result = run(argv, check=False, capture=True, cwd=cwd)
    with log.open("a", encoding="utf-8") as output_file:
        output_file.write(result.stdout)
        output_file.write(result.stderr)
    if result.returncode != 0:
        raise DotfilesError(
            f"command failed ({result.returncode}): {' '.join(os.fspath(value) for value in argv)}"
        )


def _install_maven_dependencies(
    home: Path, version: str, support: Path, m2: Path, log: Path
) -> None:
    ensure_directory(m2)
    for jar in _required_jars(support):
        name = Path(jar).stem
        _logged_run(
            (
                "mvn",
                "-q",
                "org.apache.maven.plugins:maven-install-plugin:3.1.2:install-file",
                f"-Dmaven.repo.local={m2}",
                f"-Dfile={home / 'Ghidra' / jar}",
                "-DgroupId=ghidra",
                f"-DartifactId={name}",
                f"-Dversion={version}",
                "-Dpackaging=jar",
                "-DgeneratePom=true",
            ),
            log,
        )


def _build(
    source: Path,
    home: Path,
    version: str,
    support: Path,
    work: Path,
    stage: Path,
    log: Path,
) -> None:
    m2 = work / "m2"
    _install_maven_dependencies(home, version, support, m2, log)
    _logged_run(
        (
            sys.executable,
            support / "rewrite-pom.py",
            source / "pom.xml",
            version,
            BUILD_STAMP,
        ),
        log,
    )
    _logged_run(
        (
            "mvn",
            "-Pheadless",
            f"-Dmaven.repo.local={m2}",
            "-Dmaven.test.skip=true",
            "-Djacoco.skip=true",
            "package",
        ),
        log,
        cwd=source,
    )
    jar = require_file(source / f"target/GhidraMCP-{JAR_VERSION}.jar")
    java_dir = ensure_directory(stage / "share/java")
    install_file_if_changed(jar, java_dir / jar.name)

    venv = stage / "venv"
    _logged_run(("uv", "venv", venv), log)
    python = venv / "bin/python"
    _logged_run(
        (
            "uv",
            "pip",
            "install",
            "--python",
            python,
            "--upgrade",
            "pip",
            "wheel",
            "hatchling",
        ),
        log,
    )
    _logged_run(
        ("uv", "pip", "install", "--python", python, f"mcp=={MCP_SDK_VERSION}"), log
    )
    _logged_run(("uv", "pip", "install", "--python", python, "--no-deps", source), log)


def _render_wrappers(
    stage: Path, install_root: Path, home: Path, support: Path
) -> None:
    bin_dir = ensure_directory(stage / "bin")
    values = {
        "INSTALL_ROOT": repr(os.fspath(install_root)),
        "GHIDRA_HOME": repr(os.fspath(home)),
        "JAR_VERSION": repr(JAR_VERSION),
        "PYTHON": os.fspath(install_root / "venv/bin/python"),
    }
    for name in ("httpd", "bridge", "headless", "serve"):
        render_template(
            support / f"wrappers/ghidra-mcp-{name}.py.in",
            bin_dir / f"ghidra-mcp-{name}",
            values,
            "0755",
        )


def _link_bins(install: Path, bin_dir: Path) -> None:
    ensure_directory(bin_dir)
    for name in ("httpd", "bridge", "headless", "serve"):
        link = bin_dir / f"ghidra-mcp-{name}"
        link.unlink(missing_ok=True)
        link.symlink_to(install / "bin" / link.name)


def install_ghidra_mcp(
    cache_dir: Path | None = None,
    install_prefix: Path | None = None,
    bin_dir: Path | None = None,
    *,
    force: bool = False,
    ghidra_home: Path | None = None,
) -> None:
    """Build the pinned Ghidra MCP server and Python bridge."""
    require_commands("git", "java", "mvn", "patch", "uv")
    support = _support_dir()
    cache = safe_path(cache_dir or user_cache_home() / "dotfiles/ghidra-mcp")
    install = safe_path(install_prefix or Path.home() / ".local/opt/ghidra-mcp/latest")
    links = safe_path(bin_dir or Path.home() / ".local/bin")
    home = _normalize_ghidra_home(ghidra_home) if ghidra_home else detect_ghidra_home()
    if home is None:
        raise DotfilesError(
            f"Ghidra home must contain a Ghidra/ directory: {ghidra_home}"
        )
    require_directory(home / "Ghidra")
    _verify_jars(home, support)
    java = _java_major()
    if java < 21:
        raise DotfilesError(f"Java 21 or newer is required; found Java {java}")
    detected_version = ghidra_version(home)
    build_key = (
        "\n".join((
            f"state_version={STATE_VERSION}",
            f"package_version={PACKAGE_VERSION}",
            f"upstream_rev={UPSTREAM_REV}",
            f"jar_version={JAR_VERSION}",
            f"mcp_sdk_version={MCP_SDK_VERSION}",
            f"ghidra_home={home}",
            f"ghidra_version={detected_version}",
        ))
        + "\n"
    )
    stamp = install / ".ghidra-mcp-build"
    required = tuple(
        install / f"bin/ghidra-mcp-{name}" for name in ("serve", "httpd", "bridge")
    )
    if (
        not force
        and all(path.is_file() and os.access(path, os.X_OK) for path in required)
        and stamp.is_file()
        and stamp.read_text() == build_key
    ):
        _link_bins(install, links)
        console.print(
            f"Ghidra MCP already current at {PACKAGE_VERSION} for Ghidra {detected_version}."
        )
        return
    ensure_directory(cache)
    source = cache / "source"
    _checkout(source)
    run(
        ("patch", "-d", source, "-p1"),
        input_text=require_file(support / "bridge-auth-token.patch").read_text(),
    )
    log = cache / "ghidra-mcp-build.log"
    write_if_changed(log, "")
    with tempfile.TemporaryDirectory(prefix="build-", dir=cache) as temporary:
        work = Path(temporary)
        stage = ensure_directory(work / "stage")
        ensure_directory(stage / "bin")
        console.print(
            f"Building Ghidra MCP {PACKAGE_VERSION} against Ghidra "
            f"{detected_version} at {home}."
        )
        try:
            _build(source, home, detected_version, support, work, stage, log)
            _render_wrappers(stage, install, home, support)
            write_if_changed(stage / ".ghidra-mcp-build", build_key)
        except DotfilesError as error:
            tail = "\n".join(log.read_text().splitlines()[-160:])
            raise DotfilesError(
                f"{error}\nGhidra MCP build log tail:\n{tail}"
            ) from error
        ensure_directory(install.parent)
        remove_path(install)
        stage.replace(install)
    _link_bins(install, links)
    console.print(
        f"Installed Ghidra MCP {PACKAGE_VERSION} into {install} and linked launchers in {links}."
    )


app = App(
    default_command=install_ghidra_mcp,
    version=f"install-ghidra-mcp {PACKAGE_VERSION}",
    result_action="return_none",
)


def entrypoint() -> None:
    try:
        app()
    except DotfilesError as error:
        error_console.print(f"[bold red]install-ghidra-mcp:[/bold red] {error}")
        raise SystemExit(1) from error
