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
      ../ansible/plugins/filter/dotfiles.py
      ../ansible/library/dotfiles_codesign.py
      ../ansible/library/dotfiles_selinux_service.py
      ../ansible/roles/system/files/kmscon/kmscon-refresh.py
      ../ansible/roles/system/files/kmscon/kmscon-theme-config.py
      ../ansible/roles/system/files/rustdesk-selinux/rustdesk.fc
      ../ansible/roles/system/files/rustdesk-selinux/rustdesk.te
      ../bluebuild/recipes/spectrum.yml
      ../pyproject.toml
      ../ansible/tests
      ../dotfiles/.chezmoitemplates/black_rose_doll_palette.json
      ../packages/dotfiles-python/assets
      ../packages/dotfiles-python/src/workstation
      ../packages/dotfiles-python/tests
    ];
  };

  build-system = [ python314Packages.setuptools ];
  nativeCheckInputs = [
    python314Packages.astral
    python314Packages.pytestCheckHook
  ];

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
  pytestFlags = [
    "ansible/tests"
    "packages/dotfiles-python/tests"
  ];

  doCheck = true;
  doInstallCheck = false;

  meta = {
    description = "Personal workstation utilities shared across Linux and macOS";
    mainProgram = "phone-mirror";
    platforms = lib.platforms.unix;
  };
}
