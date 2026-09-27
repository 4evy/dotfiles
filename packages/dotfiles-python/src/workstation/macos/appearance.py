"""Catppuccin Custom integration with macOS appearance preferences."""

import sys
import warnings
from importlib import import_module
from typing import Any, cast

from workstation.lib.commands import run
from workstation.lib.theme import palettes, rgb_components

APPLE_PINK_ACCENT = 6
OTHER_ICON_TINT = 10
SKYLIGHT = "/System/Library/PrivateFrameworks/SkyLight.framework"
PREFERENCE_WRITES = (
    ("-g", "AppleAccentColor", "-int", str(APPLE_PINK_ACCENT)),
    ("-g", "AppleHighlightColor", "-string", "{highlight} Other"),
    (
        "com.apple.systempreferences",
        "AppleOtherHighlightColor",
        "-string",
        "{highlight}",
    ),
)


def _accent() -> str:
    return palettes()["light"]["accent"]


def _preference_color(color: str, *, alpha: bool = False) -> str:
    components = rgb_components(color)
    channels = (*components, 1.0) if alpha else components
    return " ".join(f"{channel:.6f}" for channel in channels)


def _apply_icon_tint(color: str) -> None:
    appkit = cast("Any", import_module("AppKit"))
    objc = cast("Any", import_module("objc"))
    objc.loadBundle("SkyLight", globals(), bundle_path=SKYLIGHT)
    configuration_class = objc.lookUpClass("SLSIconAppearanceConfiguration")
    configuration = configuration_class.fetchCurrentIconAppearanceConfiguration()
    red, green, blue = rgb_components(color)
    tint = appkit.NSColor.colorWithSRGBRed_green_blue_alpha_(
        red,
        green,
        blue,
        1,
    )
    configuration.setIconTintColorName_(OTHER_ICON_TINT)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", objc.ObjCPointerWarning)
        configuration.setOtherIconTintColor_(tint.CGColor())
    configuration.save()


def _notify_color_change() -> None:
    foundation = cast("Any", import_module("Foundation"))
    center = foundation.NSDistributedNotificationCenter.defaultCenter()
    center.postNotificationName_object_userInfo_deliverImmediately_(
        "AppleColorPreferencesChangedNotification",
        None,
        None,
        True,
    )


def apply_appearance() -> None:
    """Apply the closest native accent and exact custom highlight/icon tint."""
    if sys.platform != "darwin":
        return
    accent = _accent()
    highlight = _preference_color(accent)
    for write in PREFERENCE_WRITES:
        run((
            "defaults",
            "write",
            *(value.format(highlight=highlight) for value in write),
        ))
    _apply_icon_tint(accent)
    _notify_color_change()
