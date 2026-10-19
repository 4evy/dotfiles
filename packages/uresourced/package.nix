{
  dotfilesSourcePins,
  glib,
  lib,
  meson,
  ninja,
  pipewire,
  pkg-config,
  stdenv,
  systemd,
}:
let
  sourcePin = dotfilesSourcePins.uresourced;
in
stdenv.mkDerivation {
  pname = "uresourced";
  version = lib.removePrefix "v" (lib.removePrefix "refs/tags/" sourcePin.version);
  strictDeps = true;

  src = sourcePin.outPath;

  nativeBuildInputs = lib.attrValues {
    inherit
      glib
      meson
      ninja
      pkg-config
      ;
  };

  buildInputs = lib.attrValues {
    inherit glib pipewire systemd;
  };

  mesonFlags = [
    "-Dappmanagement=true"
    "-Dsystemdsystemunitdir=${placeholder "out"}/lib/systemd/system"
    "-Dsystemduserunitdir=${placeholder "out"}/lib/systemd/user"
  ];

  doCheck = false;
  doInstallCheck = false;

  meta = {
    description = "Dynamically allocate resources to the active graphical user";
    homepage = "https://gitlab.freedesktop.org/benzea/uresourced";
    license = lib.licenses.lgpl21Plus;
    platforms = lib.platforms.linux;
  };
}
