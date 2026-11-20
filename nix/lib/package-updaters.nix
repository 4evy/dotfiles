{
  lib,
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
in
{
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
      bun2nix
      deadnix
      nixfmt
    ];
    text = ''
      bun install --ignore-scripts --lockfile-only
      bun2nix --lock-file bun.lock --copy-prefix ./ --output-file bun.nix
      deadnix --edit bun.nix
      nixfmt bun.nix
    '';
  });

  /**
    Make an updater for a binary pin owned by this repository

    # Type
    `binaryPin :: String -> String`

    # Examples
    `binaryPin "bun"` returns the path to `update-bun`
  */
  binaryPin =
    name:
    let
      program = "update-${name}";
    in
    lib.meta.getExe (writeShellApplication {
      name = program;
      meta.mainProgram = program;
      runtimeInputs = [ gh ];
      text = ''
        exec ${lib.meta.getExe updateBinaryPins} ${lib.strings.escapeShellArg name} "$@"
      '';
    });
}
