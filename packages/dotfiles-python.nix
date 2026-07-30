{
  lib,
  python314Packages,
  stdenv,
}:
python314Packages.buildPythonApplication {
  pname = "dotfiles-python";
  version = "0.1.0";
  pyproject = true;
  strictDeps = true;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../.dockerignore
      ../Justfile
      ../ansible/plugins/filter/dotfiles.py
      ../ansible/roles/system/files/kmscon/kmscon-refresh.py
      ../ansible/roles/system/files/kmscon/kmscon-theme-config.py
      ../ansible/roles/system/templates/macos/tailscale-ssh-helper.py.in
      ../pyproject.toml
      ../browser/helium.toml
      ../browser/settings
      ../ansible/tests
      ../dotfiles/.chezmoitemplates/catppuccin_palette.json
      ../npins/sources.json
      ../packages/dotfiles-python/assets
      ../packages/dotfiles-python/src/workstation
      ../packages/dotfiles-python/tests
    ];
  };

  build-system = [ python314Packages.setuptools ];
  nativeCheckInputs = [ python314Packages.pytestCheckHook ];

  # These releases are compatible, but currently trail the lower bounds in
  # the project metadata. Relax only their wheel requirements and leave the
  # source metadata untouched.
  pythonRelaxDeps = [
    "plumbum"
    "pydantic-settings"
    "pyobjc-framework-Cocoa"
  ];

  dependencies =
    (with python314Packages; [
      astral
      boltons
      cyclopts
      httpx
      httpx-retries
      jinja2
      packaging
      platformdirs
      plumbum
      psutil
      pydantic
      pydantic-settings
      rich
      tenacity
    ])
    ++ lib.optionals stdenv.hostPlatform.isDarwin [
      python314Packages.pyobjc-framework-Cocoa
    ];

  pythonImportsCheck = [ "workstation" ];
  pytestFlags = [
    "ansible/tests"
    "packages/dotfiles-python/tests"
  ];

  doCheck = true;
  doInstallCheck = false;

  meta = {
    description = "Automation commands used by the dotfiles Ansible and chezmoi workflows";
    mainProgram = "dotfiles-scripts";
    platforms = lib.platforms.unix;
  };
}
