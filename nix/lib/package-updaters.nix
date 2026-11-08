{
  lib,
  bun,
  bun2nix,
  deadnix,
  gh,
  git,
  nix,
  nixfmt,
  python3,
  writeShellApplication,
}:
{
  # Flake inputs own upstream definitions, including explicitly pinned revisions
  flakeInputs =
    names:
    lib.meta.getExe (writeShellApplication {
      name = "update-inputs-${lib.strings.concatStringsSep "-" names}";
      runtimeInputs = [
        git
        nix
        python3
      ];
      text = ''
        exec python3 ${./update-flake-inputs.py} ${lib.strings.escapeShellArgs names}
      '';
    });

  sequence =
    name: scripts:
    lib.meta.getExe (writeShellApplication {
      inherit name;
      text = lib.strings.concatMapStringsSep "\n" (
        script: lib.strings.escapeShellArgs (lib.lists.toList script)
      ) scripts;
    });

  # Local packages share the root workspace's actual dependency lock and cache
  localWorkspace = lib.meta.getExe (writeShellApplication {
    name = "update-dotfiles-workspace";
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

  # These overrides, unlike input-owned packages, own their binary hashes here
  binaryPin =
    name:
    lib.meta.getExe (writeShellApplication {
      name = "update-${name}";
      runtimeInputs = [
        gh
        python3
      ];
      text = ''
        exec python3 ${../../packages/update-binary-pins.py} ${lib.strings.escapeShellArg name} "$@"
      '';
    });
}
