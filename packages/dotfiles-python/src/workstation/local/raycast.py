import json
import os
import sys
import tempfile
import time
import tomllib
from pathlib import Path

from packaging.version import InvalidVersion, Version
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import run
from workstation.lib.files import ensure_directory, require_file, write_if_changed
from workstation.lib.http import download
from workstation.lib.paths import asset_path
from workstation.lib.retry import wait_until
from workstation.lib.templates import render_template


class RaycastUser(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    image: str | None = None
    avatar: str | None = None


class RaycastOAuthToken(BaseModel):
    model_config = ConfigDict(extra="allow")

    access_token: str = Field(min_length=1)


class RaycastProfile(BaseModel):
    current_user: RaycastUser
    oauth_token: RaycastOAuthToken
    avatar_url: str | None = None
    command_aliases: list[JsonValue] = Field(default_factory=list)


def _log(message: str) -> None:
    error_console.print(f"raycast-beta-patch: {message}")


def _warn(message: str) -> None:
    error_console.print(f"raycast-beta-patch: warning: {message}")


def _runtime_version(path: Path) -> tuple[int, Version | str]:
    try:
        return 1, Version(path.parent.name.removeprefix("node-v"))
    except InvalidVersion:
        return 0, path.parent.name


def _node_directory(app_support: Path) -> Path:
    runtime = app_support / "node/runtime"
    if not runtime.is_dir():
        raise DotfilesError(f"raycast node runtime not found: {runtime}")
    candidates = [
        directory
        for directory in runtime.glob("node-v*/bin")
        if (directory / "node").is_file() or (directory / "node.real").is_file()
    ]
    if not candidates:
        raise DotfilesError(f"raycast node runtime not found under {runtime}")
    return max(candidates, key=_runtime_version)


def _read_key(path: Path) -> str | None:
    if not path.is_file():
        return None
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise DotfilesError(f"raycast DB key cache is empty: {path}")
    return value


def _restore_node(node: Path, real: Path, hook: Path) -> None:
    if not real.is_file():
        return
    node.unlink(missing_ok=True)
    real.replace(node)
    hook.unlink(missing_ok=True)


def _write_node_wrapper(node: Path, real: Path, hook: Path, key_file: Path) -> None:
    source = asset_path("macos", "templates", "raycast-node-wrapper.py.in")
    render_template(
        source,
        node,
        {
            "python": os.fspath(sys.executable),
            "real": json.dumps(os.fspath(real)),
            "hook": json.dumps(os.fspath(hook)),
            "key_file": json.dumps(os.fspath(key_file)),
        },
        "0755",
    )


def _extract_key(
    app_support: Path, hook_source: Path, beta_app: Path
) -> tuple[Path, Path]:
    directory = _node_directory(app_support)
    hook = directory / ".keydump.cjs"
    key_file = directory / ".raycast-key-cache"
    node = directory / "node"
    real = directory / "node.real"
    if real.is_file():
        _restore_node(node, real, hook)
    cached = _read_key(key_file)
    if cached is not None:
        _log(f"using cached Raycast DB key: {key_file}")
        return node, key_file
    require_file(hook_source)
    write_if_changed(hook, f"require({json.dumps(os.fspath(hook_source))});\n")
    node.replace(real)
    try:
        _write_node_wrapper(node, real, hook, key_file)
        _log("extracting Raycast DB key")
        run(("open", beta_app))
        captured = wait_until(key_file.is_file, attempts=30, interval=1)
        run(("killall", "Raycast Beta"), check=False, capture=True)
        if not captured:
            raise DotfilesError(
                "failed to capture Raycast DB key; Raycast may not have started"
            )
        time.sleep(2)
        key = _read_key(key_file)
        if key is None:
            raise DotfilesError("failed to read captured Raycast DB key")
    finally:
        _restore_node(node, real, hook)
    _log(f"Raycast DB key extracted: {key[:16]}... ({len(key)} bytes)")
    return node, key_file


def _resize_avatar(source: Path, destination: Path) -> None:
    with Image.open(source) as image:
        image.thumbnail((256, 256), Image.Resampling.LANCZOS)
        image.convert("RGBA").save(destination, format="PNG")


def _ensure_avatar(profile: RaycastProfile, app_support: Path) -> Path:
    ensure_directory(app_support)
    destination = app_support / "avatar.png"
    configured = os.environ.get("RAYCAST_AVATAR_SRC")
    if configured and Path(configured).is_file():
        try:
            _resize_avatar(Path(configured), destination)
            _log(f"avatar resized from {configured}")
            return destination
        except (OSError, ValueError) as error:
            _warn(f"failed to resize configured avatar; trying profile URL: {error}")
    url = profile.avatar_url or ""
    if not url:
        if not destination.is_file():
            _warn("profile is missing avatar_url; continuing without avatar refresh")
        return destination
    with tempfile.TemporaryDirectory(prefix="raycast-avatar-") as temporary:
        source = Path(temporary) / "avatar"
        try:
            download(url, source)
            _resize_avatar(source, destination)
            _log(f"avatar downloaded and resized from {url}")
        except (DotfilesError, OSError, ValueError) as error:
            _warn(f"failed to download or resize Raycast avatar: {error}")
    return destination


def main() -> int:
    if sys.platform != "darwin":
        _log("not running on macOS; skipping")
        return 0
    beta_app = Path("/Applications/Raycast Beta.app")
    bundle = (
        beta_app
        / "Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources"
    )
    data_node = bundle / "backend/data.darwin-arm64.node"
    app_support = Path(
        os.environ.get(
            "RAYCAST_APP_SUPPORT",
            Path.home() / "Library/Application Support/com.raycast-x.macos",
        )
    )
    profile_dir = Path(
        os.environ.get("RAYCAST_PROFILE_DIR", Path.home() / ".config/raycast")
    )
    profile_file = Path(
        os.environ.get("RAYCAST_PROFILE_FILE", profile_dir / "profile.toml")
    )
    hook = Path(os.environ.get("RAYCAST_KEYDUMP_HOOK", profile_dir / "keydump.cjs"))
    raycast_db = Path(os.environ.get("RAYCAST_DB_CLI", profile_dir / "raycast-db.mjs"))
    if not beta_app.is_dir():
        _warn("Raycast Beta not found; skipping Raycast Beta user patch")
        return 0
    if not data_node.is_file():
        _warn(f"Raycast Beta data addon not found; skipping: {data_node}")
        return 0
    with require_file(profile_file).open("rb") as profile_handle:
        try:
            profile = RaycastProfile.model_validate(tomllib.load(profile_handle))
        except (tomllib.TOMLDecodeError, ValidationError) as error:
            raise DotfilesError(f"invalid Raycast profile: {error}") from error
    require_file(hook)
    require_file(raycast_db)
    node, key_file = _extract_key(app_support, hook, beta_app)
    avatar = _ensure_avatar(profile, app_support)
    current_user = profile.current_user
    oauth_token = profile.oauth_token
    avatar_url = avatar.resolve().as_uri()
    current_user.image = avatar_url
    current_user.avatar = avatar_url
    run(
        (
            node,
            raycast_db,
            "profile",
            "apply",
            current_user.model_dump_json(exclude_none=True),
            oauth_token.model_dump_json(),
        ),
        env={
            "RAYCAST_APP_SUPPORT": os.fspath(app_support),
            "RAYCAST_DATA_ADDON": os.fspath(data_node),
            "RAYCAST_KEY_FILE": os.fspath(key_file),
        },
    )
    command_aliases = profile.command_aliases
    if command_aliases:
        run(
            (
                node,
                raycast_db,
                "aliases",
                "apply",
                json.dumps(command_aliases, separators=(",", ":")),
            ),
            env={
                "RAYCAST_APP_SUPPORT": os.fspath(app_support),
                "RAYCAST_DATA_ADDON": os.fspath(data_node),
                "RAYCAST_KEY_FILE": os.fspath(key_file),
            },
        )
    _log("starting Raycast Beta")
    run(("open", beta_app))
    _log("Raycast Beta started")
    return 0


def entrypoint() -> None:
    try:
        raise SystemExit(main())
    except DotfilesError as error:
        raise SystemExit(f"raycast-beta-patch: error: {error}") from error
