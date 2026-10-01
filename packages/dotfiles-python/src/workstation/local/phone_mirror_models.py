"""Validated configuration and cached addresses for phone mirroring."""

import ipaddress
from collections.abc import Sequence
from subprocess import CompletedProcess
from typing import Annotated, Protocol

from cyclopts import Parameter
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

DEFAULT_NAME = "samsung-s25"
DEFAULT_PORT = 5555
PORT = Annotated[int, Field(ge=1, le=65535)]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
OptionalDriver = Annotated[str | None, BeforeValidator(lambda value: value or None)]


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

    name: str = Field(DEFAULT_NAME, min_length=1, description="Tailscale host name.")
    ip: IPAddress | None = Field(None, description="Target IP address.")
    port: PORT = Field(DEFAULT_PORT, description="ADB TCP/IP port passed to scrcpy.")
    connect_only: Annotated[bool, Parameter(negative="")] = Field(
        False, description="Connect without opening a mirror window."
    )
    render_driver: OptionalDriver = "software"
    sdl_video_driver: Annotated[
        OptionalDriver, Parameter(env_var="PHONE_MIRROR_SDL_VIDEODRIVER")
    ] = "x11"
    scrcpy_args: Annotated[tuple[str, ...], Parameter(parse=False)] = ()


class TargetCache(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    ip: IPAddress
