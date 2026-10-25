_: {
  _class = "darwin";

  networking.hostName = "evy";
  system.primary.user = "evy";
  users.users.evy.home = "/Users/evy";

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
