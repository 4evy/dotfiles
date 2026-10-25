_: {
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

  programs.ai = {
    enable = true;
    user.enable = true;
    farstep.desktop.enable = true;
    omp.keybindings = builtins.fromJSON (builtins.readFile ../../dotfiles/data/omp-keybindings.json);
    chatgpt = {
      enable = true;
      package = null;
      patchComputerUse = true;
    };
  };
}
