{ inputs, lib }:
final: prev:
let
  inherit (final)
    callPackage
    hyper-window-tiling
    stdenv
    unstable
    ;
  aiPackages = inputs.ai.packages.${stdenv.hostPlatform.system};
  inherit (aiPackages)
    ai-tools
    farstep
    farstep-desktop
    farstep-service
    ;
  inherit (hyper-window-tiling) gnome kde;
  # Farstep's Crane builders require Rust 1.99, ahead of pinned Nixpkgs
  farstepCraneLib = (inputs.ai.inputs.crane.mkLib final).overrideToolchain (
    pkgs: (inputs.rust-overlay.lib.mkRustBin { } pkgs).stable."1.99.1".minimal
  );
  farstepDesktop = farstep-desktop.override { craneLib = farstepCraneLib; };
  farstepService = farstep-service.override { craneLib = farstepCraneLib; };
  aiJavaScript = callPackage ../../../packages/ai/javascript.nix {
    inherit (aiPackages) ai-app-modules ai-javascript;
  };
  packageFiles = {
    bluebuild-v2 = ../../../packages/bluebuild/package.nix;
    # Use the managed Bun runtime rather than bypassing its upstream override
    dotfiles-workstation = ../../../tools/workstation/package.nix;
    dotfiles-typescript-tools = ../../../package.nix;
    hyper-window-tiling = ../../../tools/tiling/package.nix;
    rex = ../../../packages/rex/package.nix;
    super-engineering = ../../../packages/super-engineering/package.nix;
    theme-run = ../../../tools/theme/run/package.nix;
    toshy-runtime = ../../../packages/toshy/runtime/package.nix;
    uresourced = ../../../packages/uresourced/package.nix;
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
  aiTools = aiPackages // {
    ai-javascript = aiJavaScript;
    ai-tools = ai-tools.override {
      ai-javascript = aiJavaScript;
    };
    farstep-desktop = farstepDesktop;
    farstep-service = farstepService;
    farstep = farstep.override {
      farstep-desktop = farstepDesktop;
      farstep-service = farstepService;
    };
  };
  bun2nix = inputs.bun2nix.packages.${stdenv.hostPlatform.system}.default;
  # Upstream schema downloads have no deadline, including recursive $ref fetches
  check-jsonschema = prev.check-jsonschema.overridePythonAttrs (
    old:
    let
      connectTimeoutSeconds = 10;
      readTimeoutSeconds = 30;
    in
    {
      postPatch = (old.postPatch or "") + ''
        substituteInPlace src/check_jsonschema/cachedownloader.py \
          --replace-fail 'requests.get(file_url, stream=True)' \
            'requests.get(file_url, stream=True, timeout=(${toString connectTimeoutSeconds}, ${toString readTimeoutSeconds}))'
      '';
    }
  );
  inherit (unstable) gh;
  hyper-window-tiling-gnome = gnome;
  hyper-window-tiling-kde = kde;
  super-engineering-native = final.super-engineering.native;
}
