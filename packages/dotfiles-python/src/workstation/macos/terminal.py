"""Apple Terminal profile provisioning."""

import sys
from importlib import import_module

from pydantic import TypeAdapter

from workstation.lib.paths import asset_path


def _dark_palette() -> dict[str, str]:
    palette = TypeAdapter(dict[str, dict[str, str]]).validate_json(
        asset_path("desktop", "black_rose_doll_palette.json").read_text()
    )
    return palette["dark"]


def terminal_profile() -> None:
    """Install the Black Rose Doll Dark profile in Terminal.app."""
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

    palette = _dark_palette()
    name = "Black Rose Doll Dark"
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
        "TextColor": color(palette["text"]),
        "TextBoldColor": color(palette["rose"]),
        "BackgroundColor": color(palette["base"]),
        "CursorColor": color(palette["rose"]),
        "SelectionColor": color(palette["highlightMed"]),
    }
    ansi_roles = (
        "surface1",
        "love",
        "pine",
        "gold",
        "pine",
        "rose",
        "foam",
        "muted",
        "highlightLow",
        "love",
        "pine",
        "gold",
        "pine",
        "rose",
        "foam",
        "subtle",
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
    profile.update({
        key: color(palette[role]) for key, role in zip(keys, ansi_roles, strict=True)
    })
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
