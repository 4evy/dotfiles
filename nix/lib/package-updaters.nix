{
  lib,
  bash,
  bun,
  bun2nix,
  deadnix,
  gh,
  git,
  nix,
  nixfmt,
  writeShellApplication,
  writers,
}:
let
  # The repository formats Python separately from the writer's 79-column check
  writerOptions.flakeIgnore = [ "E501" ];
  updateFlakeInputs =
    writers.writePython3Bin "update-flake-inputs" writerOptions
      ./update-flake-inputs.py;
  updateBinaryPins =
    writers.writePython3Bin "update-binary-pins" writerOptions
      ../../packages/update-binary-pins.py;

  /**
    Package the updater for a binary pin owned by this repository

    # Inputs
    `name`: binary pin name, either `"bun"` or `"helium-darwin"`

    # Type
    `binaryPinPackage :: String -> Derivation`

    # Examples
    `(binaryPinPackage "bun").meta.mainProgram` returns `"update-bun"`
  */
  binaryPinPackage =
    name:
    let
      program = "update-${name}";
      application = writeShellApplication {
        name = program;
        meta.mainProgram = program;
        passthru.updateScript = lib.meta.getExe application;
        runtimeInputs = [ gh ];
        text = ''
          exec ${lib.meta.getExe updateBinaryPins} ${lib.strings.escapeShellArg name} "$@"
        '';
      };
    in
    application;
in
{
  inherit binaryPinPackage;

  /**
    Make an updater for the given owning input names, including explicit pins

    # Type
    `flakeInputs :: [String] -> String`

    # Examples
    `flakeInputs [ "nixpkgs" ]` returns the path to `update-inputs-nixpkgs`
  */
  flakeInputs =
    names:
    let
      name = "update-inputs-${lib.strings.concatStringsSep "-" names}";
    in
    lib.meta.getExe (writeShellApplication {
      inherit name;
      meta.mainProgram = name;
      runtimeInputs = [
        git
        nix
      ];
      text = ''
        exec ${lib.meta.getExe updateFlakeInputs} ${lib.strings.escapeShellArgs names}
      '';
    });

  /**
    Make an updater with the given name that runs scripts or argv lists in order

    # Type
    `sequence :: String -> [(String | [String])] -> String`

    # Examples
    `sequence "update-all" [ [ "/bin/echo" "done" ] ]` returns the path to
    `update-all`, which prints `done`
  */
  sequence =
    name: scripts:
    lib.meta.getExe (writeShellApplication {
      inherit name;
      meta.mainProgram = name;
      text = lib.strings.concatMapStringsSep "\n" (
        script: lib.strings.escapeShellArgs (lib.lists.toList script)
      ) scripts;
    });

  # Local packages share the root workspace's actual dependency lock and cache
  localWorkspace = lib.meta.getExe (writeShellApplication {
    name = "update-dotfiles-workspace";
    meta.mainProgram = "update-dotfiles-workspace";
    runtimeInputs = [
      bun
      deadnix
    ];
    text = ''
      bun install --ignore-scripts --lockfile-only
      BUN_NIX_BUN2NIX=${lib.meta.getExe bun2nix} \
        BUN_NIX_NIXFMT=${lib.meta.getExe nixfmt} \
        ${lib.meta.getExe bash} ${../../tools/bun/generate-nix.sh}
    '';
  });

  /**
    Make an updater for a binary pin owned by this repository

    # Type
    `binaryPin :: String -> String`

    # Examples
    `binaryPin "bun"` returns the path to `update-bun`
  */
  binaryPin = name: lib.meta.getExe (binaryPinPackage name);
}
