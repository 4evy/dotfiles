import pytest

from workstation.errors import DotfilesError
from workstation.lib.validation import (
    octal_mode,
    safe_path,
)


@pytest.mark.parametrize("value", ["/", "nested/.."])
def test_safe_path_rejects_destructive_targets(value: str) -> None:
    with pytest.raises(DotfilesError, match="unsafe path"):
        safe_path(value)


@pytest.mark.parametrize("value", ["8"])
def test_octal_mode_rejects_non_octal_input(value: str) -> None:
    with pytest.raises(DotfilesError, match="must be octal"):
        octal_mode(value)


@pytest.mark.parametrize(("value", "expected"), [("0644", 0o644), (0o600, 0o600)])
def test_octal_mode_accepts_strings_and_native_mode_integers(
    value: str | int, expected: int
) -> None:
    assert octal_mode(value) == expected


@pytest.mark.parametrize("value", ["10000"])
def test_octal_mode_rejects_values_outside_permission_bits(
    value: str | int,
) -> None:
    with pytest.raises(DotfilesError, match=r"must be (octal|a permission mode)"):
        octal_mode(value)
