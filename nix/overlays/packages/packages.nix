{ inputs, lib }:
final: prev:
let
  inherit (final)
    callPackage
    fetchFromGitHub
    hyper-window-tiling
    makeRustPlatform
    stdenv
    unstable
    ;
  aiPackages = inputs.ai.packages.${stdenv.hostPlatform.system};
  inherit (aiPackages)
    ai-tools
    farstep
    farstep-native
    ghidra-mcp
    ;
  inherit (hyper-window-tiling) gnome kde;
  # Farstep requires Rust 1.99 while the upstream input still provides 1.98
  rustToolchain = (inputs.rust-overlay.lib.mkRustBin { } final).stable."1.99.1".minimal;
  farstepNative = farstep-native.override {
    rustPlatform = makeRustPlatform {
      cargo = rustToolchain;
      rustc = rustToolchain;
    };
  };
  # The pinned Ghidra MCP revision has an incorrect upstream source hash
  ghidraMcp = ghidra-mcp.override {
    fetchFromGitHub =
      args:
      fetchFromGitHub (
        args
        // lib.optionalAttrs ((args.rev or null) == "0c9573efc174bbb1ea8f3c2336ec4bb3ebfe9f10") {
          hash = "sha256-zdlsKxNU1E/fSQ0NcfrufKulk8A05LYEL4qejblUo+g=";
        }
      );
  };
  packageFiles = {
    bluebuild-v2 = ../../../packages/bluebuild/package.nix;
    # Use the managed Bun runtime rather than bypassing its upstream override
    dotfiles-workstation = ../../../tools/workstation/package.nix;
    dotfiles-typescript-tools = ../../../package.nix;
    hyper-window-tiling = ../../../tools/tiling/package.nix;
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
        python315
        ;
    };
  };

  packages = lib.mapAttrs (name: file: callPackage file (packageArgs.${name} or { })) packageFiles;
in
packages
// {
  aiTools = aiPackages // {
    ghidra-mcp = ghidraMcp;
    ai-tools = ai-tools.override { ghidra-mcp = ghidraMcp; };
    farstep-native = farstepNative;
    farstep = farstep.override { farstep-native = farstepNative; };
  };
  bun2nix = inputs.bun2nix.packages.${stdenv.hostPlatform.system}.default;
  # Upstream schema downloads have no deadline, including recursive $ref fetches
  check-jsonschema = prev.check-jsonschema.overridePythonAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      substituteInPlace src/check_jsonschema/cachedownloader.py \
        --replace-fail 'requests.get(file_url, stream=True)' \
          'requests.get(file_url, stream=True, timeout=(10, 30))'
    '';
  });
  inherit (unstable) gh;
  hyper-window-tiling-gnome = gnome;
  hyper-window-tiling-kde = kde;
}
