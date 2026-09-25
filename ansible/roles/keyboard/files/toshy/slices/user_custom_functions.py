import json
import os
from collections.abc import Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from xwaykeyz.config_api import (  # ty: ignore[unresolved-import]
        devices_api,
        timeouts,
    )


def _nd_env_list(name: str, default: Sequence[str] = ()) -> list[str]:
    value = os.environ.get(name)
    if value is None:
        return list(default)

    value = value.strip()
    if not value or value.casefold() in {"all", "auto", "none"}:
        return []

    if value.startswith("["):
        parsed = json.loads(value)
        if not isinstance(parsed, list) or not all(
            isinstance(item, str) for item in parsed
        ):
            raise ValueError(f"{name} must be a JSON array of strings")
        return parsed

    return [line.strip() for line in value.splitlines() if line.strip()]


# Keep upstream's keymapper API slice intact. These calls intentionally live in
# Toshy's user extension point and only override the values dotfiles owns.
timeouts(suspend=1)
devices_api(
    only_devices=_nd_env_list(
        "DOTFILES_TOSHY_ONLY_DEVICES",
        default=["/run/kanata-main/main"],
    ),
    ignore_devices=_nd_env_list("DOTFILES_TOSHY_IGNORE_DEVICES"),
)
