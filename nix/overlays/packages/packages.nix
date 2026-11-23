{ inputs, lib }:
final: _prev:
let
  inherit (final)
    callPackage
    dotfilesPackageUpdaters
    hyper-window-tiling
    stdenv
    unstable
    ;
  aiPackages = inputs.ai.packages.${stdenv.hostPlatform.system};

  /**
    Attach a flake-input updater without dropping the package's other passthru
    attributes.

    # Inputs

    `names`: Upstream flake input names.
    `package`: Derivation to override.

    # Type

    `withInputs :: [String] -> Derivation -> Derivation`

    # Examples

    ```nix
    (withInputs [ "ai" ] aiJavaScript).updateScript
    => "/nix/store/…-update-inputs-ai/bin/update-inputs-ai"
    ```
  */
  withInputs =
    names: package:
    package.overrideAttrs (old: {
      passthru = (old.passthru or { }) // {
        updateScript = dotfilesPackageUpdaters.flakeInputs names;
      };
    });
  inherit (aiPackages) ai-tools;
  inherit (hyper-window-tiling) gnome kde;
  aiJavaScript = callPackage ../../../packages/ai/javascript.nix {
    inherit (aiPackages) ai-app-modules ai-javascript;
  };
  packageFiles = {
    # Use the managed Bun runtime rather than bypassing its upstream override
    dotfiles-workstation = ../../../tools/workstation/package.nix;
    dotfiles-typescript-tools = ../../../package.nix;
    hyper-window-tiling = ../../../tools/tiling/package.nix;
    rex = ../../../packages/rex/package.nix;
    super-engineering = ../../../packages/super-engineering/package.nix;
    theme-run = ../../../tools/theme/run/package.nix;
    toshy-runtime = ../../../packages/toshy/runtime/package.nix;
  };

  packageArgs = {
    toshy-runtime = {
      # Toshy replaces packageOverrides, so extend its interpreter's package set
      # before applying upstream's pins without affecting other Python runtimes
      inherit
        (unstable.extend (
          _final: prev:
          let
            inherit (prev) pythonPackagesExtensions;
          in
          {
            pythonPackagesExtensions = pythonPackagesExtensions ++ [
              (
                _pyFinal: pyPrev:
                let
                  inherit (pyPrev) i3ipc;
                in
                {
                  # Concurrent X11 sync calls can consume each other's replies
                  # Serialize request/reply pairs while keeping checks enabled
                  i3ipc = i3ipc.overridePythonAttrs (old: {
                    patches = (old.patches or [ ]) ++ [
                      ../../../packages/toshy/runtime/i3ipc/i3ipc.patch
                    ];
                    passthru = (old.passthru or { }) // {
                      inherit (final.dotfilesSourcePins.toshy) updateScript;
                    };
                  });
                }
              )
            ];
          }
        ))
        python314
        ;
    };
  };

  packages = lib.attrsets.mapAttrs (
    name: file: callPackage file (packageArgs.${name} or { })
  ) packageFiles;
in
packages
// {
  aiTools = lib.attrsets.mapAttrs (_: package: withInputs [ "ai" ] package) (
    aiPackages
    // {
      ai-javascript = aiJavaScript;
      ai-tools = ai-tools.override {
        ai-javascript = aiJavaScript;
      };
    }
  );
  bun2nix = withInputs [ "bun2nix" ] inputs.bun2nix.packages.${stdenv.hostPlatform.system}.default;
  inherit (unstable) gh;
  hyper-window-tiling-gnome = gnome;
  hyper-window-tiling-kde = kde;
  super-engineering-native = final.super-engineering.native;
}
