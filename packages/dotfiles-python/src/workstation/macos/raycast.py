import json
import shutil
import subprocess
import time
from collections.abc import Sequence
from pathlib import Path

from workstation.lib.theme import palettes

RAYCAST_APP = Path("/Applications/Raycast.app")
DATABASE_CLI = Path.home() / ".config/raycast/raycast-db.mts"
THEME_ROLE_FIELDS = (
    ("background", "base"),
    ("backgroundSecondary", "surface"),
    ("foreground", "text"),
    ("accent", "love"),
    ("selection", "rose"),
    ("loader", "iris"),
    ("red", "red"),
    ("orange", "peach"),
    ("yellow", "yellow"),
    ("green", "green"),
    ("blue", "blue"),
    ("purple", "mauve"),
    ("magenta", "pink"),
)
THEME_FIELDS = ("name", "appearance", *(field for field, _role in THEME_ROLE_FIELDS))
PALETTES = palettes()
THEMES = tuple(
    {
        "name": f"T3 Chat {appearance.title()}",
        "appearance": appearance,
        **{field: PALETTES[appearance][role] for field, role in THEME_ROLE_FIELDS},
    }
    for appearance in ("light", "dark")
)


def call_database(node: str, method: str, arguments: object = None) -> object:
    completed = subprocess.run(
        (
            node,
            str(DATABASE_CLI),
            "call",
            method,
            json.dumps(arguments or [], separators=(",", ":")),
        ),
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or "Raycast database call failed"
        raise RuntimeError(f"{method}: {message}")
    try:
        payload: object = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{method}: invalid database response") from error
    if not isinstance(payload, dict):
        raise TypeError(f"{method}: invalid database response")
    return payload.get("result")


def require_theme_id(value: object, context: str) -> str:
    theme_id = value.get("id") if isinstance(value, dict) else None
    if not isinstance(theme_id, str):
        raise TypeError(f"{context}: Raycast did not return a theme ID")
    return theme_id


def upsert_theme(
    node: str, installed: Sequence[object], desired: dict[str, str]
) -> tuple[str, bool]:
    current = next(
        (
            theme
            for theme in installed
            if isinstance(theme, dict)
            and theme.get("name") == desired["name"]
            and theme.get("appearance") == desired["appearance"]
        ),
        None,
    )
    if current is None:
        created = call_database(node, "settings.addTheme", [desired])
        return require_theme_id(created, f"create {desired['name']}"), True
    theme_id = require_theme_id(current, f"inspect {desired['name']}")
    if all(current.get(field) == desired[field] for field in THEME_FIELDS):
        return theme_id, False
    updated = call_database(node, "settings.updateTheme", [theme_id, desired])
    require_theme_id(updated, f"update {desired['name']}")
    return theme_id, True


def apply_themes(node: str) -> bool:
    installed = call_database(node, "settings.allThemes")
    if not isinstance(installed, list):
        raise TypeError("settings.allThemes: invalid database response")

    changed = False
    active_ids: dict[str, str] = {}
    for desired in THEMES:
        theme_id, theme_changed = upsert_theme(node, installed, desired)
        active_ids[desired["appearance"]] = theme_id
        changed |= theme_changed

    general = call_database(node, "settings.getGeneralSettings")
    if not isinstance(general, dict):
        raise TypeError("settings.getGeneralSettings: invalid database response")
    for appearance, setting_type, setting_key in (
        ("dark", "ThemeDarkId", "themeDarkId"),
        ("light", "ThemeLightId", "themeLightId"),
    ):
        theme_id = active_ids[appearance]
        if general.get(setting_key) == theme_id:
            continue
        call_database(
            node,
            "settings.updateGeneralSetting",
            [{"type": setting_type, "value": theme_id}],
        )
        changed = True

    return changed


def restart_raycast() -> None:
    subprocess.run(
        ("/usr/bin/killall", "Raycast"),
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    error = "unknown launch error"
    for _ in range(10):
        completed = subprocess.run(
            ("/usr/bin/open", "-g", str(RAYCAST_APP)),
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode == 0:
            return
        error = completed.stderr.strip() or error
        time.sleep(0.5)
    raise RuntimeError(f"Raycast restart failed: {error}")


def main() -> None:
    if not RAYCAST_APP.is_dir():
        print("Raycast T3 Chat theme install skipped: Raycast is not installed")
        return
    node = shutil.which("node")
    if node is None or not DATABASE_CLI.is_file():
        print("Raycast T3 Chat theme install skipped: database bridge not found")
        return

    if not apply_themes(node):
        print("Raycast T3 Chat themes already current")
        return

    restart_raycast()
    print("Raycast T3 Chat light and dark themes installed")


if __name__ == "__main__":
    main()
