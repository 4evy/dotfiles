#!/usr/bin/env python3.14
"""Shared stdio client for Codex's newline-delimited app-server protocol."""

import asyncio
import json
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path
from typing import cast


@dataclass
class AppServer:
    process: asyncio.subprocess.Process
    identifiers: Iterator[int] = field(default_factory=lambda: count(1))

    async def send(self, payload: Mapping[str, object]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("Codex app server has no input stream")
        self.process.stdin.write(json.dumps(payload).encode() + b"\n")
        await self.process.stdin.drain()

    async def request(self, method: str, params: Mapping[str, object]) -> object:
        identifier = next(self.identifiers)
        try:
            async with asyncio.timeout(5):
                await self.send({
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "method": method,
                    "params": params,
                })
                return await self.receive(identifier)
        except TimeoutError as exc:
            raise TimeoutError(f"Codex {method} response timed out") from exc

    async def receive(self, identifier: int) -> object:
        if self.process.stdout is None:
            raise RuntimeError("Codex app server has no output stream")
        async for line in self.process.stdout:
            payload: object = json.loads(line)
            response = (
                cast("dict[str, object]", payload) if isinstance(payload, dict) else {}
            )
            if "method" in response or response.get("id") != identifier:
                continue
            if "error" in response:
                raise RuntimeError(response["error"])
            return response.get("result")
        raise RuntimeError("Codex app server exited")


@asynccontextmanager
async def app_server(
    real: str | Path, *, client_name: str = "codex-launcher"
) -> AsyncIterator[AppServer]:
    process = await asyncio.create_subprocess_exec(
        real,
        "app-server",
        "--stdio",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=16 * 1024 * 1024,
    )
    try:
        server = AppServer(process)
        await server.request(
            "initialize",
            {"clientInfo": {"name": client_name, "version": "1"}},
        )
        async with asyncio.timeout(5):
            await server.send({"jsonrpc": "2.0", "method": "initialized"})
        yield server
    finally:
        with suppress(ProcessLookupError):
            process.terminate()
        try:
            async with asyncio.timeout(3):
                await process.communicate()
        except TimeoutError:
            with suppress(ProcessLookupError):
                process.kill()
            await process.communicate()
