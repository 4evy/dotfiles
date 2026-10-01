{
  lib,
  python314Packages,
  stdenv,
}:
let
  repositoryRoot = ../..;
  packageRoot = ./.;
  pyproject = lib.importTOML (repositoryRoot + /pyproject.toml);
in
python314Packages.buildPythonApplication {
  pname = pyproject.project.name;
  inherit (pyproject.project) version;
  pyproject = true;
  strictDeps = true;

  src = lib.fileset.toSource {
    root = repositoryRoot;
    fileset = lib.fileset.unions [
      (repositoryRoot + /pyproject.toml)
      (repositoryRoot + /dotfiles/.chezmoidata/catppuccin_custom.json)
      (packageRoot + /assets)
      (packageRoot + /src/workstation)
    ];
  };

  build-system = [ python314Packages.setuptools ];
  dependencies =
    (with python314Packages; [
      cyclopts
      packaging
      platformdirs
      psutil
      pydantic
      pydantic-settings
      rich
    ])
    ++ lib.optionals stdenv.hostPlatform.isDarwin [
      python314Packages.pyobjc-framework-Cocoa
    ];

  pythonImportsCheck = [ "workstation" ];
  doCheck = false;
  doInstallCheck = false;

  meta = {
    description = "Personal workstation utilities shared across Linux and macOS";
    homepage = "https://github.com/4evy/dotfiles";
    license = lib.licenses.mit;
    mainProgram = "phone-mirror";
    maintainers = [ lib.maintainers._4evy ];
    platforms = lib.platforms.unix;
  };
}
