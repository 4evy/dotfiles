{
  buildGoModule,
  go_1_27,
  lib,
}:

let
  buildGo127Module = buildGoModule.override { go = go_1_27; };
in
buildGo127Module {
  pname = "theme-run";
  version = "0.1.0";

  __structuredAttrs = true;
  strictDeps = true;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./go.mod
      ./go.sum
      ./cmd
      ./internal
    ];
  };

  vendorHash = "sha256-nirrM+dC/ioT38IYeaVRZB2/NLzcEGLLnrnNq7xkdVc=";
  subPackages = [ "cmd/theme-run" ];

  ldflags = [
    "-s"
    "-w"
  ];

  meta = {
    description = "Theme-aware launcher for terminal applications";
    homepage = "https://github.com/4evy/dotfiles";
    license = lib.licenses.mit;
    mainProgram = "theme-run";
    maintainers = [ lib.maintainers._4evy ];
    platforms = lib.platforms.unix;
  };
}
