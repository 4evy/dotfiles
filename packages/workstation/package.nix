{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  makeWrapper,
  gjs,
  glib,
  flatpak,
  aiTools,
}:
let
  metadata = lib.importJSON ./package.json;
  inherit (aiTools) farstep-native;
  inherit (bun2nix) hook;
  wrapperArgs = lib.optionals stdenvNoCC.hostPlatform.isLinux [
    "--prefix"
    "PATH"
    ":"
    (lib.makeBinPath [
      gjs
      farstep-native
    ])
    "--prefix"
    "GI_TYPELIB_PATH"
    ":"
    (lib.makeSearchPath "lib/girepository-1.0" [
      (lib.getLib glib)
      flatpak
    ])
  ];
in
# Bun embeds its own runtime, so bundling does not need a C/C++ toolchain
stdenvNoCC.mkDerivation {
  pname = metadata.name;
  inherit (metadata) version;
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./src
      ./assets
      ../../lib/typescript
      ../../dotfiles/data/palette/palette.json
    ];
  };
  postUnpack = ''
    sourceRoot="$sourceRoot/packages/workstation"
  '';
  bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };
  nativeBuildInputs = lib.attrValues {
    inherit bun hook makeWrapper;
  };
  strictDeps = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  # The executable carries Bun's bundled JavaScript after its native image
  dontStrip = true;
  bunInstallFlags = [
    "--frozen-lockfile"
    "--offline"
    "--linker=hoisted"
    "--backend=copyfile"
  ];

  buildPhase = ''
    runHook preBuild
    bun run build
    bun -e 'import { commands } from "./src/cli.ts"; console.log(Object.keys(commands).join("\n"))' > commands
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/workstation "$out/libexec/workstation"
    makeWrapper "$out/libexec/workstation" "$out/bin/workstation" ${lib.escapeShellArgs wrapperArgs}
    while IFS= read -r command; do
      makeWrapper "$out/bin/workstation" "$out/bin/$command" --add-flags "$command"
    done < commands
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/workstation" --help
    "$out/bin/phone-mirror" --help
    runHook postInstallCheck
  '';

  meta = {
    description = "Personal workstation utilities shared across Linux and macOS";
    homepage = "https://github.com/4evy/dotfiles";
    license = lib.licenses.mit;
    mainProgram = "phone-mirror";
    maintainers = [ lib.maintainers._4evy ];
    platforms = [
      "aarch64-darwin"
      "x86_64-linux"
    ];
  };
}
