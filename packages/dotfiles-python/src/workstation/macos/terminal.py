#!/usr/bin/env python3.14
"""Apple Terminal profile provisioning."""

import sys
from importlib import import_module

from workstation.lib.theme import palettes, rgb_components


def terminal_profile() -> None:
    """Install the Catppuccin Custom light and dark profiles in Terminal.app."""
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
        red, green, blue = rgb_components(value)
        return archived(
            ns_color.colorWithSRGBRed_green_blue_alpha_(
                red,
                green,
                blue,
                1,
            )
        )

    theme_palettes = palettes()
    font = ns_font.fontWithName_size_("JetBrainsMonoNFM-Regular", 15)
    if font is None:
        font = ns_font.monospacedSystemFontOfSize_weight_(15, 0)

    archived_font = archived(font)
    color_roles = {
        "TextColor": "terminalForeground",
        "TextBoldColor": "terminalCursor",
        "BackgroundColor": "terminalBackground",
        "CursorColor": "terminalCursor",
        "SelectionColor": "surface1",
        "ANSIBlackColor": "ansiBlack",
        "ANSIRedColor": "red",
        "ANSIGreenColor": "green",
        "ANSIYellowColor": "yellow",
        "ANSIBlueColor": "blue",
        "ANSIMagentaColor": "pink",
        "ANSICyanColor": "sky",
        "ANSIWhiteColor": "ansiWhite",
        "ANSIBrightBlackColor": "mutedForeground",
        "ANSIBrightRedColor": "red",
        "ANSIBrightGreenColor": "green",
        "ANSIBrightYellowColor": "yellow",
        "ANSIBrightBlueColor": "blue",
        "ANSIBrightMagentaColor": "pink",
        "ANSIBrightCyanColor": "sky",
        "ANSIBrightWhiteColor": "ansiWhite",
    }

    def profile(variant: str) -> tuple[str, dict[str, object]]:
        palette = theme_palettes[variant]
        colors = {
            role: color(palette[role]) for role in dict.fromkeys(color_roles.values())
        }
        name = f"Catppuccin Custom {variant.title()}"
        values: dict[str, object] = {
            "name": name,
            "type": "Window Settings",
            "ProfileCurrentVersion": 2.09,
            "columnCount": 120,
            "rowCount": 30,
            "Font": archived_font,
            "FontAntialias": True,
            "FontHeightSpacing": 1,
            "FontWidthSpacing": 1,
            "BackgroundBlur": 0,
            "BackgroundBlurInactive": 0,
            "BackgroundSettingsForInactiveWindows": False,
            "DynamicANSIForegroundColors": False,
        }
        values.update({key: colors[role] for key, role in color_roles.items()})
        return name, values

    defaults = ns_user_defaults.standardUserDefaults()
    domain = dict(defaults.persistentDomainForName_("com.apple.Terminal") or {})
    settings = dict(domain.get("Window Settings") or {})
    for variant in ("light", "dark"):
        name, values = profile(variant)
        settings[name] = values
    current_variant = (
        "Dark" if defaults.stringForKey_("AppleInterfaceStyle") == "Dark" else "Light"
    )
    default_name = f"Catppuccin Custom {current_variant}"
    domain.update({
        "Window Settings": settings,
        "Default Window Settings": default_name,
        "Startup Window Settings": default_name,
        "DefaultProfilesVersion": 2,
        "ProfileCurrentVersion": 2.09,
    })
    defaults.setPersistentDomain_forName_(domain, "com.apple.Terminal")
