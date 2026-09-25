"""Validated configuration and cached addresses for phone mirroring."""

import ipaddress
from collections.abc import Sequence
from subprocess import CompletedProcess
from typing import Annotated, Protocol

from pydantic import BaseModel, ConfigDict, Field

DEFAULT_NAME = "samsung-s25"
DEFAULT_PORT = 5555
PORT = Annotated[int, Field(ge=1, le=65535)]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class RunCommand(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        input_text: str | None = None,
    ) -> CompletedProcess[str]: ...


class Config(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str = Field(DEFAULT_NAME, min_length=1)
    ip: IPAddress | None = None
    port: PORT = DEFAULT_PORT
    connect_only: bool = False
    render_driver: str | None = "software"
    sdl_video_driver: str | None = "x11"
    scrcpy_args: tuple[str, ...] = ()


class TargetCache(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    ip: IPAddress
