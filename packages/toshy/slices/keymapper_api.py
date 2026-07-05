import json
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xwaykeyz.config_api import (
        Key,
        devices_api,
        dump_diagnostics_key,
        emergency_eject_key,
        keyboard_layout_correction,
        throttle_delays,
        timeouts,
    )


def _nd_env_list(name, default=None):
    value = os.environ.get(name)
    if value is None:
        return list(default or [])

    value = value.strip()
    if value == "" or value.casefold() in {"all", "auto", "none"}:
        return []

    if value.startswith("["):
        parsed = json.loads(value)
        if not isinstance(parsed, list) or not all(
            isinstance(item, str) for item in parsed
        ):
            raise ValueError(f"{name} must be a JSON array of strings")
        return parsed

    return [line.strip() for line in value.splitlines() if line.strip()]


dump_diagnostics_key(Key.F15)
emergency_eject_key(Key.F16)

timeouts(
    multipurpose=1,
    suspend=1,
)

throttle_delays(
    key_pre_delay_ms=8,
    key_post_delay_ms=12,
)

devices_api(
    only_devices=_nd_env_list(
        "DOTFILES_TOSHY_ONLY_DEVICES",
        default=[
            "/run/kanata-main/main",
        ],
    ),
    ignore_devices=_nd_env_list("DOTFILES_TOSHY_IGNORE_DEVICES"),
)

try:
    keyboard_layout_correction(
        correction_enabled=False,
        correct_number_row=False,
        symbol_miss_policy="fold",
        folded_miss_policy="placeholder",
        symbol_placeholder="?",
    )
except (NameError, TypeError):
    try:
        keyboard_layout_correction(
            enabled=False,
            correct_number_row=False,
        )
    except (NameError, TypeError):
        pass

try:
    import xwaykeyz.config_api as _xwaykeyz_config_api

    _xwaykeyz_config_api._LAYOUT_CORRECTION["enabled"] = False
except (ImportError, AttributeError, KeyError):
    pass
