"""Validated environment settings for workstation commands."""

from typing import ClassVar, Self

from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic_settings.exceptions import SettingsError

from workstation.errors import DotfilesError


class EnvironmentSettings(BaseSettings):
    """Immutable settings with consistent validation and error reporting."""

    model_config = SettingsConfigDict(
        extra="ignore",
        frozen=True,
        validate_default=True,
    )

    configuration_name: ClassVar[str]

    @classmethod
    def load(cls) -> Self:
        """Load and validate this settings model from the environment."""
        try:
            return cls()
        except (SettingsError, ValidationError) as error:
            raise DotfilesError(
                f"invalid {cls.configuration_name} configuration: {error}"
            ) from error
