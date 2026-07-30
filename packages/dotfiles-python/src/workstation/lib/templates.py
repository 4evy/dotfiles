from collections.abc import Mapping
from pathlib import Path

from jinja2 import Environment, StrictUndefined

from workstation.lib.files import require_file, write_if_changed

_ENVIRONMENT = Environment(
    autoescape=False,
    keep_trailing_newline=True,
    undefined=StrictUndefined,
    variable_start_string="@",
    variable_end_string="@",
)


def render_template_content(
    source: str | Path,
    values: Mapping[str, object],
) -> str:
    """Render a strict text template without writing it."""
    template = _ENVIRONMENT.from_string(require_file(source).read_text())
    return template.render(**values)


def render_template(
    source: str | Path,
    destination: str | Path,
    values: Mapping[str, object],
    mode: int | str = "0644",
) -> bool:
    return write_if_changed(
        destination,
        render_template_content(source, values),
        mode,
    )
