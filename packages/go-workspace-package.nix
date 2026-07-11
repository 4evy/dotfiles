{
  buildGoModule,
  lib,
}:

let
  repoRoot = ../.;
  defaultVendorHash = "sha256-xTpoVJ3gwx629GO453xy0RS8Df+bngRWUvnRknyZurQ=";
  defaultSource =
    extraSourceFiles:
    lib.fileset.toSource {
      root = repoRoot;
      fileset = lib.fileset.unions (
        [
          ../go.mod
          ../go.sum
          ../cmd
          ../internal
        ]
        ++ extraSourceFiles
      );
    };
in
{
  pname,
  subPackages,
  version ? "dev",
  vendorHash ? defaultVendorHash,
  extraSourceFiles ? [ ],
  src ? defaultSource extraSourceFiles,
  env ? { },
  ldflags ? [ ],
  meta ? { },
  ...
}@attrs:

buildGoModule (
  removeAttrs attrs [
    "extraSourceFiles"
    "env"
    "ldflags"
    "meta"
    "pname"
    "src"
    "subPackages"
    "vendorHash"
    "version"
  ]
  // {
    inherit
      meta
      pname
      src
      subPackages
      vendorHash
      version
      ;
    env = {
      CGO_ENABLED = 0;
    }
    // env;
    ldflags = [
      "-s"
      "-w"
    ]
    ++ ldflags;
  }
)
