{
  fetchFromGitLab,
  glib,
  lib,
  meson,
  ninja,
  pipewire,
  pkg-config,
  sourcePin,
  stdenv,
  systemd,
}:

stdenv.mkDerivation {
  pname = "uresourced";
  inherit (sourcePin) version;
  strictDeps = true;

  src = fetchFromGitLab {
    domain = sourcePin.repository.host;
    owner = sourcePin.repository.owner;
    repo = sourcePin.repository.name;
    rev = sourcePin.revision;
    hash = sourcePin.hashes.nix_source;
  };

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
