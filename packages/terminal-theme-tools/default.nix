{
  fixDarwinDylibNames,
  lib,
  pkg-config,
  stdenv,
  testers,
  validatePkgConfig,
  versionCheckHook,
  writeShellScriptBin,
  zig_0_16,
}:

let
  zig = zig_0_16;
  darwinTargetFlags = lib.optionals stdenv.hostPlatform.isDarwin [
    "-Dtarget=${stdenv.hostPlatform.parsed.cpu.name}-macos.${stdenv.hostPlatform.darwinMinVersion}"
  ];
  xcrunWrapper = writeShellScriptBin "xcrun" ''
    printf '%s\n' "$SDKROOT"
  '';
  xcodeselectWrapper = writeShellScriptBin "xcode-select" ''
    printf '%s\n' "$DEVELOPER_DIR"
  '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "terminal-theme-tools";
  version = "0.3.0";

  __structuredAttrs = true;
  strictDeps = true;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./README.md
      ./build.zig
      ./build.zig.zon
      ./build_support.zig
      ./config
      ./include
      ./src
      ./tests
      ./vendor
    ];
  };

  zigDeps = zig.fetchDeps {
    inherit (finalAttrs) pname version src;
    fetchAll = true;
    hash = "sha256-W9CZFYWyhLxX9WGoUWC3QyMgy50p4wSwC9Ly1TPDLV4=";
  };

  nativeBuildInputs = [
    validatePkgConfig
    zig
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [
    fixDarwinDylibNames
    xcrunWrapper
    xcodeselectWrapper
  ];

  postConfigure = ''
    cp -rLT ${finalAttrs.zigDeps} "$ZIG_GLOBAL_CACHE_DIR/p"
    chmod -R u+w "$ZIG_GLOBAL_CACHE_DIR/p"
  '';

  dontSetZigDefaultFlags = true;
  zigBuildFlags = [
    "-Dcpu=baseline"
    "--release=small"
  ]
  ++ darwinTargetFlags;
  zigCheckFlags = [ "-Dcpu=baseline" ] ++ darwinTargetFlags;

  doCheck = true;

  outputs = [
    "out"
    "lib"
    "dev"
  ];

  postInstall = ''
    moveToOutput "lib/libterminal_theme_tools*${stdenv.hostPlatform.extensions.sharedLibrary}*" "$lib"
    moveToOutput "lib/libterminal_theme_tools.a" "$dev"

    mkdir -p "$dev/lib/pkgconfig"
    cat > "$dev/lib/pkgconfig/terminal-theme-tools.pc" <<EOF
    prefix=$dev
    libdir=$lib/lib
    includedir=$dev/include

    Name: terminal-theme-tools
    Description: C23 API for terminal-theme-tools
    Version: ${finalAttrs.version}
    Libs: -L\''${libdir} -lterminal_theme_tools
    Cflags: -I\''${includedir}
    EOF
  '';

  nativeInstallCheckInputs = [
    pkg-config
    versionCheckHook
  ];
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    test -f "$dev/include/terminal_theme_tools.h"
    test -f "$dev/lib/libterminal_theme_tools.a"
    test -f "$dev/lib/pkgconfig/terminal-theme-tools.pc"
    test -f "$lib/lib/libterminal_theme_tools${stdenv.hostPlatform.extensions.sharedLibrary}"
    export PKG_CONFIG_PATH="$dev/lib/pkgconfig"
    test "$(pkg-config --modversion terminal-theme-tools)" = "${finalAttrs.version}"
    ${stdenv.cc.targetPrefix}cc \
      -std=c23 -pedantic-errors -Wall -Wextra -Werror \
      tests/c_api_test.c \
      $(pkg-config --cflags --libs terminal-theme-tools) \
      -o "$TMPDIR/c-api-install-check"
    "$TMPDIR/c-api-install-check"
    "$out/bin/terminal-theme-run" --help
    "$out/bin/terminal-theme-run" true

    runHook postInstallCheck
  '';

  passthru.tests.pkg-config = testers.hasPkgConfigModules {
    package = finalAttrs.finalPackage;
    versionCheck = true;
  };

  meta = {
    description = "Theme-aware launcher for terminal applications";
    license = lib.licenses.mit;
    mainProgram = "terminal-theme-run";
    maintainers = [ lib.maintainers._4evy ];
    pkgConfigModules = [ "terminal-theme-tools" ];
    inherit (zig.meta) platforms;
  };
})
