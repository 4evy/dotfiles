"""Validated configuration and Tailscale data for phone mirroring."""

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


class TailscaleNode(BaseModel):
    model_config = ConfigDict(extra="ignore")

    host_name: str = Field(alias="HostName")
    dns_name: str = Field(default="", alias="DNSName")
    addresses: tuple[IPAddress, ...] = Field(default=(), alias="TailscaleIPs")

    @property
    def names(self) -> set[str]:
        values = (self.host_name, self.dns_name)
        normalized = (value.rstrip(".").casefold() for value in values if value)
        return {
            name for value in normalized for name in (value, value.split(".", 1)[0])
        }


class TailscaleStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    own_node: TailscaleNode | None = Field(default=None, alias="Self")
    peers: dict[str, TailscaleNode] = Field(default_factory=dict, alias="Peer")

    @property
    def nodes(self) -> tuple[TailscaleNode, ...]:
        own = (self.own_node,) if self.own_node is not None else ()
        return (*own, *self.peers.values())


class TargetCache(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    ip: IPAddress
