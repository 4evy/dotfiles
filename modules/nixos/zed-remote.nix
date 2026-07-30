{
  config,
  lib,
  pkgs,
  ...
}:
{
  systemd.tmpfiles.settings.zed-remote =
    let
      inherit (config.local.user) group home name;
      inherit (pkgs.zed-editor.remote_server) version;
      binaryName = "zed-remote-server-stable-${version}";
    in
    {
      "${home}/.zed_server".d = {
        mode = "0755";
        user = name;
        inherit group;
      };
      "${home}/.zed_server/${binaryName}"."L+".argument =
        lib.meta.getExe' pkgs.zed-editor.remote_server binaryName;
    };
}
