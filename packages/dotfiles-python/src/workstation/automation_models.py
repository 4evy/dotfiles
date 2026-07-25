"""Typed protocol shared by dotfiles automation frontends."""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

PROTOCOL_VERSION = 1


class AutomationContext(BaseModel):
    """Selected Ansible context exposed to a Python operation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    repo_root: Path
    home: Path
    cache_dir: Path | None = None
    data_dir: Path | None = None
    bin_dir: Path | None = None
    system: str | None = None
    architecture: str | None = None


class OperationRequest(BaseModel):
    """One versioned request from the Ansible adapter."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    protocol: Literal[1] = PROTOCOL_VERSION
    command: list[str] = Field(min_length=1)
    context: AutomationContext
    check: bool = False
    diff: bool = False


class OperationResult(BaseModel):
    """Framework-neutral result produced by an automation operation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    changed: bool = False
    msg: str | None = None
    data: dict[str, JsonValue] = Field(default_factory=dict)
    diff: dict[str, JsonValue] | None = None
    warnings: list[str] = Field(default_factory=list)
    skipped: bool = False


class OperationResponse(OperationResult):
    """Wire response returned to the Ansible adapter."""

    protocol: Literal[1] = PROTOCOL_VERSION
    failed: bool = False
