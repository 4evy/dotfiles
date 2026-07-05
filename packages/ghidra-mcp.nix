{
  coreutils,
  ghidra-mcp-headless,
  lib,
  symlinkJoin,
  writeShellApplication,
}:

let
  packageSet = ghidra-mcp-headless;
  httpdExe = lib.getExe' packageSet.httpd "ghidra-mcp-httpd";
  bridgeExe = lib.getExe' packageSet.bridge "ghidra-mcp-bridge";
  serve = writeShellApplication {
    name = "ghidra-mcp-serve";
    runtimeInputs = [ coreutils ];
    text = ''
      set -euo pipefail

      : "''${GHIDRA_MCP_BIND:=127.0.0.1}"
      : "''${GHIDRA_MCP_PORT:=8089}"
      : "''${GHIDRA_MCP_BRIDGE_HOST:=127.0.0.1}"
      : "''${GHIDRA_MCP_BRIDGE_PORT:=8090}"
      : "''${GHIDRA_MCP_BRIDGE_TRANSPORT:=streamable-http}"
      : "''${GHIDRA_MCP_ALLOW_SCRIPTS:=1}"

      if [ -z "''${GHIDRA_MCP_URL:-}" ]; then
        GHIDRA_MCP_URL="http://''${GHIDRA_MCP_BIND}:''${GHIDRA_MCP_PORT}"
      fi

      if [ -z "''${GHIDRA_MCP_STATE:-}" ]; then
        if [ -n "''${XDG_STATE_HOME:-}" ]; then
          GHIDRA_MCP_STATE="''${XDG_STATE_HOME}/ghidra-mcp-headless"
        else
          GHIDRA_MCP_STATE="''${HOME}/.local/state/ghidra-mcp-headless"
        fi
      fi

      export \
        GHIDRA_MCP_ALLOW_SCRIPTS \
        GHIDRA_MCP_BIND \
        GHIDRA_MCP_BRIDGE_HOST \
        GHIDRA_MCP_BRIDGE_PORT \
        GHIDRA_MCP_BRIDGE_TRANSPORT \
        GHIDRA_MCP_PORT \
        GHIDRA_MCP_STATE \
        GHIDRA_MCP_URL

      mkdir -p "$GHIDRA_MCP_STATE"

      ${httpdExe} &
      httpd_pid="$!"

      cleanup() {
        kill "$httpd_pid" >/dev/null 2>&1 || true
        wait "$httpd_pid" >/dev/null 2>&1 || true
      }
      trap cleanup EXIT INT TERM

      ${bridgeExe}
    '';
  };
in
symlinkJoin {
  name = "ghidra-mcp-${packageSet.version}";
  paths = [
    packageSet.ghidra
    packageSet.httpd
    packageSet.bridge
    packageSet.launcher
    serve
  ];

  passthru = {
    inherit packageSet serve;
    inherit (packageSet)
      bridge
      ghidra
      httpd
      launcher
      server
      ;
  };

  meta = packageSet.meta // {
    description = "Ghidra MCP headless server, bridge, launcher, and local service helper";
    mainProgram = "ghidra-mcp-serve";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
