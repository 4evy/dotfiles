{
  config,
  dotfilesPackages,
  lib,
  ...
}:
let
  inherit (lib.options) mkOption;

  types = lib.types;
  stateDir = config.services.ghidra-mcp.stateDir;
in
{
  options.services.ghidra-mcp = {
    enable = lib.options.mkEnableOption "Ghidra MCP on-demand tools for cxg";

    package = mkOption {
      type = types.package;
      default = dotfilesPackages.ghidra-mcp;
      defaultText = lib.literalExpression "dotfilesPackages.ghidra-mcp";
      description = "Package that provides ghidra-mcp-serve, ghidra-mcp-httpd, and ghidra-mcp-bridge.";
    };

    user = mkOption {
      type = types.str;
      default = config.local.user.name;
      defaultText = lib.literalExpression "config.local.user.name";
      description = "User that runs the Ghidra MCP services.";
    };

    group = mkOption {
      type = types.str;
      default = config.local.user.group;
      defaultText = lib.literalExpression "config.local.user.group";
      description = "Group that owns the Ghidra MCP state directory.";
    };

    httpHost = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };

    httpPort = mkOption {
      type = types.port;
      default = 8089;
    };

    mcpHost = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };

    mcpPort = mkOption {
      type = types.port;
      default = 8090;
    };

    stateDir = mkOption {
      type = types.path;
      default = "${config.local.user.home}/.local/state/ghidra-mcp-headless";
      defaultText = lib.literalExpression ''"''${config.local.user.home}/.local/state/ghidra-mcp-headless"'';
    };

    allowScripts = mkOption {
      type = types.bool;
      default = true;
      description = "Enable Ghidra MCP script endpoints in the local headless backend.";
    };

    environmentFiles = mkOption {
      type = types.listOf types.path;
      default = [ ];
      example = [ "/run/keys/ghidra-mcp.env" ];
      description = ''
        Environment files to use with a manually defined Ghidra MCP service.
        The stock module installs the on-demand cxg helper package and does not
        start a system service.
      '';
    };

    extraEnvironment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Extra environment variables reserved for local Ghidra MCP service overrides.";
    };
  };

  config = lib.modules.mkIf config.services.ghidra-mcp.enable {
    environment.systemPackages = with config.services.ghidra-mcp; [
      package
      package.ghidra
      package.httpd
      package.bridge
      package.launcher
    ];

    systemd.tmpfiles.settings.ghidra-mcp = {
      "${toString stateDir}".d = {
        mode = "0755";
        user = config.services.ghidra-mcp.user;
        group = config.services.ghidra-mcp.group;
      };
    };

    environment.sessionVariables = {
      GHIDRA_MCP_ALLOW_SCRIPTS = if config.services.ghidra-mcp.allowScripts then "1" else "0";
      GHIDRA_MCP_BIND = config.services.ghidra-mcp.httpHost;
      GHIDRA_MCP_BRIDGE_HOST = config.services.ghidra-mcp.mcpHost;
      GHIDRA_MCP_BRIDGE_PORT = toString config.services.ghidra-mcp.mcpPort;
      GHIDRA_MCP_BRIDGE_TRANSPORT = "streamable-http";
      GHIDRA_MCP_PORT = toString config.services.ghidra-mcp.httpPort;
      GHIDRA_MCP_STATE = toString stateDir;
      GHIDRA_MCP_URL = "http://${config.services.ghidra-mcp.httpHost}:${toString config.services.ghidra-mcp.httpPort}";
    };
  };
}
