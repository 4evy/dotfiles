{
  config,
  dotfilesPackages,
  lib,
  ...
}:
let
  inherit (lib.options) mkOption mkPackageOption;
  inherit (lib.types)
    bool
    externalPath
    nonEmptyStr
    port
    ;

  cfg = config.services.ghidra-mcp;
in
{
  options.services.ghidra-mcp = {
    enable = lib.options.mkEnableOption "Ghidra MCP on-demand tools for cxg";

    package = mkPackageOption dotfilesPackages "ghidra-mcp" {
      pkgsText = "dotfilesPackages";
      extraDescription = "It must provide the server, HTTP daemon, bridge, launcher, and Ghidra passthru attributes.";
    };

    user = mkOption {
      type = nonEmptyStr;
      default = config.local.user.name;
      defaultText = lib.literalExpression "config.local.user.name";
      description = "User that owns the Ghidra MCP state and runs its on-demand tools.";
    };

    group = mkOption {
      type = nonEmptyStr;
      default = config.local.user.group;
      defaultText = lib.literalExpression "config.local.user.group";
      description = "Group that owns the Ghidra MCP state directory.";
    };

    httpHost = mkOption {
      type = nonEmptyStr;
      default = "127.0.0.1";
      description = "Address on which the Ghidra MCP HTTP server listens.";
    };

    httpPort = mkOption {
      type = port;
      default = 8089;
      description = "Port on which the Ghidra MCP HTTP server listens.";
    };

    mcpHost = mkOption {
      type = nonEmptyStr;
      default = "127.0.0.1";
      description = "Address on which the headless Ghidra MCP bridge listens.";
    };

    mcpPort = mkOption {
      type = port;
      default = 8090;
      description = "Port on which the headless Ghidra MCP bridge listens.";
    };

    stateDir = mkOption {
      type = externalPath;
      default = "${config.local.user.home}/.local/state/ghidra-mcp-headless";
      defaultText = lib.literalExpression ''"''${config.local.user.home}/.local/state/ghidra-mcp-headless"'';
      description = "Mutable state directory used by the headless Ghidra backend.";
    };

    allowScripts = mkOption {
      type = bool;
      default = true;
      description = "Enable Ghidra MCP script endpoints in the local headless backend.";
    };
  };

  config = lib.modules.mkIf cfg.enable {
    environment.systemPackages = with cfg; [
      package
      package.ghidra
      package.httpd
      package.bridge
      package.launcher
    ];

    systemd.tmpfiles.settings.ghidra-mcp = {
      "${toString cfg.stateDir}".d = {
        mode = "0755";
        inherit (cfg) group user;
      };
    };

    environment.sessionVariables = {
      GHIDRA_MCP_ALLOW_SCRIPTS = if cfg.allowScripts then "1" else "0";
      GHIDRA_MCP_BIND = cfg.httpHost;
      GHIDRA_MCP_BRIDGE_HOST = cfg.mcpHost;
      GHIDRA_MCP_BRIDGE_PORT = toString cfg.mcpPort;
      GHIDRA_MCP_BRIDGE_TRANSPORT = "streamable-http";
      GHIDRA_MCP_PORT = toString cfg.httpPort;
      GHIDRA_MCP_STATE = toString cfg.stateDir;
      GHIDRA_MCP_URL = "http://${cfg.httpHost}:${toString cfg.httpPort}";
    };
  };
}
