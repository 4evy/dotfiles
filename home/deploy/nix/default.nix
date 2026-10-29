{
  pkgs,
  packages,
  environment,
}:
let
  inherit (pkgs)
    helium-browser
    helium-configured
    lib
    linkFarm
    writeText
    ;
  home = environment.HOME or "";
  xdg =
    name: fallback:
    let
      value = environment.${name} or "";
    in
    if value == "" then "${home}/${fallback}" else value;
  configHome = xdg "XDG_CONFIG_HOME" ".config";
  dataHome = xdg "XDG_DATA_HOME" ".local/share";
  stateHome = xdg "XDG_STATE_HOME" ".local/state";
  profile = "${stateHome}/hjem/standalone/current-profile";
  heliumAppDir = linkFarm "helium-browser-app" {
    "helium-wrapper" = lib.getExe helium-browser;
    # Tweezle matches desktop_exec against the configured launcher name
    "helium.desktop" = "${helium-configured}/share/applications/helium.desktop";
    "product_logo_256.png" = "${helium-browser}/share/icons/hicolor/256x256/apps/helium.png";
  };
  environmentFile = writeText "hjem-environment.conf" ''
    PATH=${profile}/bin:''${PATH}
    MANPATH=${profile}/share/man:''${MANPATH}
    INFOPATH=${profile}/share/info:''${INFOPATH}
    XDG_DATA_DIRS=${profile}/share:''${XDG_DATA_DIRS:-/usr/local/share:/usr/share}
  '';
  # Runtime home and state directories may contain XML metacharacters
  fonts = writeText "hjem-fonts.conf" ''
    <?xml version="1.0"?>
    <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
    <fontconfig>
      <dir>${lib.escapeXML "${profile}/share/fonts"}</dir>
    </fontconfig>
  '';
in
assert lib.assertMsg (
  home != "" && lib.hasPrefix "/" home
) "Hjem requires an absolute HOME in its runtime environment";
{
  packages = map toString packages;
  manifest = {
    version = 3;
    files = [
      {
        type = "symlink";
        source = toString fonts;
        target = "${configHome}/fontconfig/conf.d/10-hjem-fonts.conf";
      }
      {
        type = "symlink";
        source = toString heliumAppDir;
        target = "${dataHome}/hjem/helium";
      }
      {
        type = "symlink";
        source = toString environmentFile;
        target = "${configHome}/environment.d/50-hjem.conf";
      }
    ];
  };
}
