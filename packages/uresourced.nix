{
  glib,
  lib,
  meson,
  ninja,
  pipewire,
  pkg-config,
  source,
  stdenv,
  systemd,
  version,
}:

stdenv.mkDerivation {
  pname = "uresourced";
  inherit version;
  strictDeps = true;

  src = source;

  nativeBuildInputs = [
    glib
    meson
    ninja
    pkg-config
  ];

  buildInputs = [
    glib
    pipewire
    systemd
  ];

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
