{
  stdenvNoCC,
  bun,
  bun2nix,
  lib,
}:

stdenvNoCC.mkDerivation {
  pname = "theme-run";
  version = "0.1.0";

  strictDeps = true;
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../bun.lock
      ../../../home/package.json
      ../../../lib/typescript
      ../../../home/files/.local/lib/package.json
      ../../workstation/package.json
      ../../tiling/package.json
      ../../../home/files/.local/lib/typescript/process.ts
      ../../tiling/vendor/fallow
      ./main.ts
      ./config.ts
      ./launch.ts
      ./theme.ts
      ./defaults.toml
    ];
  };
  bunDeps = import ../../../nix/lib/bun/dependencies.nix { inherit lib bun2nix; };
  nativeBuildInputs = [
    bun
    bun2nix.hook
  ];
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  # Stripping would discard the JavaScript embedded after Bun's native image
  dontStrip = true;
  bunInstallFlags = [
    "--frozen-lockfile"
    "--offline"
    "--production"
    "--linker=hoisted"
    "--backend=copyfile"
  ];

  buildPhase = ''
    runHook preBuild
    bun build --compile --minify \
      --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
      tools/theme/run/main.ts --outfile theme-run
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 theme-run "$out/bin/theme-run"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/theme-run" --version
    COLOR_SCHEME=dark THEME_RUN_CONFIG= "$out/bin/theme-run" --print-theme-no-terminal
    runHook postInstallCheck
  '';

  meta = {
    description = "Theme-aware launcher for terminal applications";
    homepage = "https://github.com/4evy/dotfiles";
    license = lib.licenses.mit;
    mainProgram = "theme-run";
    maintainers = [ lib.maintainers._4evy ];
    platforms = bun.meta.platforms;
  };
}
