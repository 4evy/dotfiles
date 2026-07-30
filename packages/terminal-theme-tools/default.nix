{
  glib,
  lib,
  libvterm-neovim,
  meson,
  ninja,
  pkg-config,
  stdenv,
  tomlc17,
}:

stdenv.mkDerivation {
  pname = "terminal-theme-tools";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./.clang-tidy
      ./README.md
      ./data
      ./meson
      ./meson.build
      ./meson.options
      ./src
      ./subprojects/tomlc17.wrap
      ./subprojects/packagefiles/tomlc17
      ./tests
    ];
  };

  strictDeps = true;
  nativeBuildInputs = [
    meson
    ninja
    pkg-config
  ];
  buildInputs = [
    glib
    libvterm-neovim
    tomlc17
  ];

  doCheck = true;
  doInstallCheck = false;

  meta = {
    description = "Theme-aware wrappers for terminal applications";
    license = lib.licenses.mit;
    mainProgram = "terminal-theme-run";
    platforms = lib.platforms.linux;
  };
}
