"""Validated configuration and external data models for phone mirroring."""

import datetime as dt
import ipaddress
from collections.abc import Sequence
from typing import Annotated, Protocol

from pydantic import BaseModel, ConfigDict, Field

from workstation.lib.commands import CommandResult

DEFAULT_NAME = "samsung-s25"
DEFAULT_STABLE_PORT = 5555
DEFAULT_SCAN_PORTS = "30000-49999"
PORT = Annotated[int, Field(ge=1, le=65535)]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class RunCommand(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        input_text: str | None = None,
    ) -> CommandResult: ...


class MdnsService(BaseModel):
    model_config = ConfigDict(frozen=True)

    instance: str
    service: str
    host: str
    port: PORT


class Config(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str = DEFAULT_NAME
    ip: str | None = None
    stable_port: PORT = DEFAULT_STABLE_PORT
    scan_start: PORT = 30000
    scan_end: PORT = 49999
    connect_only: bool = False
    keep_random_port: bool = False
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


class PortCache(BaseModel):
    model_config = ConfigDict(frozen=True)

    version: int = 1
    host: str
    port: PORT
    updated_at: dt.datetime = Field(default_factory=lambda: dt.datetime.now(dt.UTC))
