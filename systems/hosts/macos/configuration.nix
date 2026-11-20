{ lib, pkgs, ... }:
let
  inherit (pkgs) coreutils;

  jaq = lib.meta.getExe pkgs.jaq;
  affinity = pkgs.writers.writePython3Bin "affinity-mcp" {
    libraries = [ pkgs.python3Packages.mcp_1 ];
    # Keep the source's 88-column formatting while checking other diagnostics
    flakeIgnore = [ "E501" ];
  } ./affinity.py;
in
{
  _class = "darwin";

  networking.hostName = "evy";
  system.primary.user = "evy";
  users.users.evy.home = "/Users/evy";

  home.file = {
    # Hjem owns the shared command files
    ".omp/agent/commands/commit.md".enable = false;
    ".omp/agent/commands/rebase.md".enable = false;
    # Preserve the locally maintained review profile
    ".codex/review.config.toml".enable = false;
  };

  # App-materialized plugin manifests retain store paths across activations
  # Refresh both the marketplace source and installed copies after config merges
  home.activation.codexCuaRuntime = {
    after = [ "codexMutableSettings" ];
    before = [ ];
    data = ''
      (
        set -euo pipefail
        shopt -s nullglob
        runtime="$(${jaq} --from toml '
          .mcp_servers.node_repl |
          {
            CUA_REPL_NODE_REPL_PATH: .command,
            CODEX_CLI_PATH: .env.CODEX_CLI_PATH
          }
        ' "$HOME/.codex/config.toml")"
        for manifest in \
          "$HOME"/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/unified-computer-use/.mcp.json \
          "$HOME"/.codex/plugins/cache/openai-bundled/unified-computer-use/*/.mcp.json; do
          [[ -f "$manifest" ]] || continue
          (
            candidate="$(${lib.meta.getExe' coreutils "mktemp"} "$manifest.XXXXXX")"
            trap 'rm -f -- "$candidate"' EXIT
            ${jaq} --argjson runtime "$runtime" \
              '.mcpServers.cua_repl.env += $runtime' "$manifest" > "$candidate"
            ${lib.meta.getExe' coreutils "chmod"} --reference="$manifest" "$candidate"
            ${lib.meta.getExe' coreutils "mv"} -fT -- "$candidate" "$manifest"
          )
        done
      )
    '';
  };

  # Keep startup independent of Affinity's app-hosted SSE server
  programs.codex.settings.mcp_servers.affinity = {
    command = lib.meta.getExe affinity;
    enabled = true;
  };

  programs.ai = {
    enable = true;
    user.enable = true;
    farstep.desktop.enable = true;
    overrides = {
      ".codex/config.toml" = lib.trivial.importJSON ../../../home/data/codex/config.json;
      ".config/opencode/opencode.json" = lib.trivial.importJSON ../../../home/data/opencode/config.json;
    };
    omp = {
      keybindings = lib.trivial.importJSON ../../../home/data/omp/keybindings.json;
      settings = lib.trivial.importJSON ../../../home/data/omp/config.json;
      # Affinity serves SSE while the desktop app is open
      mcp.mcpServers.affinity = {
        type = "sse";
        url = "http://localhost:6767/sse";
        enabled = true;
        startup = "manual";
        shutdown = "agent_end";
      };
    };
    chatgpt = {
      enable = true;
      package = null;
      patchComputerUse = true;
    };
  };
}
