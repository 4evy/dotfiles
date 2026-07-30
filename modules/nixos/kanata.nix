{ dotfilesPackages, ... }:
{
  services.kanata = {
    enable = true;
    package = dotfilesPackages.kanata-with-cmd;
    keyboards.main = {
      configFile = builtins.path {
        path = ../../dotfiles/dot_config/kanata/kanata.kbd;
        name = "kanata-config";
      };
    };
  };
}
