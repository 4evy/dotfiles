import pytest

from workstation.errors import DotfilesError
from workstation.lib.validation import (
    octal_mode,
    path_component,
    safe_path,
    template_name,
)


@pytest.mark.parametrize("value", ["", ".", "..", "nested/name", "/absolute"])
def test_path_component_rejects_traversal_and_nested_paths(value: str) -> None:
    with pytest.raises(DotfilesError, match="single path component"):
        path_component(value)


@pytest.mark.parametrize("value", ["", ".", "..", "/", "//", "nested/.."])
def test_safe_path_rejects_destructive_targets(value: str) -> None:
    with pytest.raises(DotfilesError, match="unsafe path"):
        safe_path(value)


@pytest.mark.parametrize("value", ["", "8", "0o755", "-1", "755 "])
def test_octal_mode_rejects_non_octal_input(value: str) -> None:
    with pytest.raises(DotfilesError, match="must be octal"):
        octal_mode(value)


@pytest.mark.parametrize(
    ("value", "expected"), [("0644", 0o644), ("755", 0o755), (0o600, 0o600)]
)
def test_octal_mode_accepts_strings_and_native_mode_integers(
    value: str | int, expected: int
) -> None:
    assert octal_mode(value) == expected


@pytest.mark.parametrize("value", [True, -1, 0o10000, "10000"])
def test_octal_mode_rejects_values_outside_permission_bits(
    value: str | int,
) -> None:
    with pytest.raises(DotfilesError, match=r"must be (octal|a permission mode)"):
        octal_mode(value)


@pytest.mark.parametrize("value", ["NAME", "NAME_2", "A"])
def test_template_name_accepts_environment_style_names(value: str) -> None:
    assert template_name(value) == value


@pytest.mark.parametrize("value", ["", "lower", "2FAST", "HAS-DASH", "HAS SPACE"])
def test_template_name_rejects_ambiguous_replacements(value: str) -> None:
    with pytest.raises(DotfilesError, match="invalid template replacement name"):
        template_name(value)
