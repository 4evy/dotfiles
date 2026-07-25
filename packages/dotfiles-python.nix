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
      ../pyproject.toml
      ../browser/helium-profile-avatar.png
      ../browser/helium.toml
      ../browser/settings
      ../manifests
      ../patches/ghostty
      ../packages/dotfiles-python/assets
      ../packages/dotfiles-python/src/workstation
      ../spectrum/scripts/spectrum_build
    ];
  };

  build-system = [ python314Packages.setuptools ];

  # Nixpkgs supplies the backend explicitly and does not resolve build-system
  # requirements from PyPI. Its setuptools 80 is sufficient for this project.
  postPatch = ''
    substituteInPlace pyproject.toml --replace-fail 'setuptools>=83' 'setuptools>=80'
    substituteInPlace pyproject.toml \
      --replace-fail 'httpx-retries>=0.6' 'httpx-retries>=0.5' \
      --replace-fail 'plumbum>=2' 'plumbum>=1.10' \
      --replace-fail 'pydantic>=2.13' 'pydantic>=2.12' \
      --replace-fail 'pydantic-settings>=2.14.2' 'pydantic-settings>=2.12' \
      --replace-fail 'pyobjc-framework-Cocoa>=12' 'pyobjc-framework-Cocoa>=11' \
      --replace-fail 'rich>=15' 'rich>=14'
  '';

  dependencies =
    (with python314Packages; [
      astral
      boltons
      cyclopts
      defusedxml
      filelock
      githubkit
      humanize
      httpx
      httpx-retries
      jinja2
      jsonschema
      packaging
      pillow
      platformdirs
      plumbum
      psutil
      pydantic
      pydantic-settings
      questionary
      rich
      tenacity
    ])
    ++ lib.optionals stdenv.hostPlatform.isDarwin [
      python314Packages.pyobjc-framework-Cocoa
    ];

  # yaml-language-server is supplied by its dedicated Nix package. Keep
  # system-runner here: it imports this application's modules and dependencies.
  postInstall = ''
    rm -f "$out/bin/yaml-language-server"
  '';

  doCheck = false;
  doInstallCheck = false;

  meta = {
    description = "Automation commands used by the dotfiles Ansible and chezmoi workflows";
    mainProgram = "dotfiles-scripts";
    platforms = lib.platforms.unix;
  };
}
