"""Connect to Affinity only when a discovery or tool request needs it"""

import json
from contextlib import asynccontextmanager
from datetime import timedelta

import anyio
from mcp import ClientSession, types
from mcp.client.sse import sse_client
from mcp.server import Server
from mcp.server.stdio import stdio_server

server = Server(
    "affinity",
    instructions=(
        "Use list_tools to discover Affinity's tools and their input schemas, "
        "then call_tool to invoke one. Affinity must be open with MCP enabled "
        "when using these tools. Each request connects on demand."
    ),
)


@asynccontextmanager
async def affinity_session():
    initialized = False
    try:
        # Leave time for cleanup before Codex's default 60-second tool deadline
        with anyio.fail_after(55):
            async with (
                sse_client("http://localhost:6767/sse", timeout=5) as streams,
                ClientSession(
                    *streams, read_timeout_seconds=timedelta(seconds=45)
                ) as session,
            ):
                with anyio.fail_after(5):
                    await session.initialize()
                initialized = True
                yield session
    except Exception as error:
        if initialized:
            raise RuntimeError(
                "The Affinity request failed. Its outcome may be unknown. "
                "Check the document before repeating an editing action."
            ) from error
        raise RuntimeError(
            "Affinity is unavailable. Open Affinity with its MCP server enabled, "
            "then retry this tool."
        ) from error


@server.list_tools()
async def list_tools():
    return [
        types.Tool(
            name="list_tools",
            description="Discover Affinity tools and input schemas on demand",
            inputSchema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
            annotations=types.ToolAnnotations(readOnlyHint=True),
        ),
        types.Tool(
            name="call_tool",
            description="Call an Affinity tool discovered through list_tools",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "arguments": {"type": "object"},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        ),
    ]


@server.call_tool()
async def call_tool(name, arguments):
    if name not in {"list_tools", "call_tool"}:
        raise ValueError(f"Unknown bridge tool: {name}")
    async with affinity_session() as session:
        if name == "call_tool":
            return await session.call_tool(
                arguments["name"], arguments.get("arguments", {})
            )
        tools = []
        cursor = None
        while True:
            page = await session.list_tools(cursor=cursor)
            tools.extend(
                tool.model_dump(by_alias=True, exclude_none=True) for tool in page.tools
            )
            cursor = page.nextCursor
            if cursor is None:
                break
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=json.dumps({"tools": tools}))]
        )


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )


if __name__ == "__main__":
    anyio.run(main)
