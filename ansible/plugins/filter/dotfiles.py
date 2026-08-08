"""Controller-side filters for declarative dotfiles state."""

import ast
from collections.abc import Callable


def hex_color_to_rgb_csv(value: object) -> str:
    """Convert a six-digit CSS hex color to Chromium's R,G,B flag format."""
    text = value.strip().removeprefix("#") if isinstance(value, str) else ""
    if len(text) != 6:
        raise ValueError(f"expected a six-digit hex color, got {value!r}")
    try:
        channels = tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))
    except ValueError as error:
        raise ValueError(f"expected a six-digit hex color, got {value!r}") from error
    return ",".join(map(str, channels))


def merge_gvariant_string_list(current: object, value: str) -> str:
    """Append one string to a GVariant string list without losing existing values."""
    text = current if isinstance(current, str) else ""
    text = text.strip().removeprefix("@as ").strip()
    try:
        parsed = ast.literal_eval(text)
    except (SyntaxError, ValueError):  # fmt: skip
        parsed = []
    if not isinstance(parsed, list):
        parsed = []
    result = [item for item in parsed if isinstance(item, str)]
    if value not in result:
        result.append(value)
    return repr(result)


class FilterModule:
    """Expose dotfiles filters to Ansible/Jinja."""

    def filters(self) -> dict[str, Callable[..., object]]:
        """Return filters exported by this plugin."""
        return {
            "hex_color_to_rgb_csv": hex_color_to_rgb_csv,
            "merge_gvariant_string_list": merge_gvariant_string_list,
        }
