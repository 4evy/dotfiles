"""Apple Terminal profile provisioning."""

import sys
from importlib import import_module


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
