{ lib, pkgs, ... }: {
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
        runtime="$(${lib.getExe pkgs.jaq} --from toml '
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
            candidate="$(${pkgs.coreutils}/bin/mktemp "$manifest.XXXXXX")"
            trap 'rm -f -- "$candidate"' EXIT
            ${lib.getExe pkgs.jaq} --argjson runtime "$runtime" \
              '.mcpServers.cua_repl.env += $runtime' "$manifest" > "$candidate"
            ${pkgs.coreutils}/bin/chmod --reference="$manifest" "$candidate"
            ${pkgs.coreutils}/bin/mv -fT -- "$candidate" "$manifest"
          )
        done
      )
    '';
  };

  programs.ai = {
    enable = true;
    user.enable = true;
    farstep.desktop.enable = true;
    omp.keybindings = lib.importJSON ../../../home/data/omp/keybindings.json;
    chatgpt = {
      enable = true;
      package = null;
      patchComputerUse = true;
    };
  };
}
