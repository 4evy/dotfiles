{
  lib,
  fetchFromGitHub,
  python314Packages,
  stdenv,
}:
let
  repositoryRoot = ../..;
  packageRoot = ./.;
  pyproject = lib.importTOML (repositoryRoot + /pyproject.toml);
  lock = lib.importTOML (repositoryRoot + /uv.lock);
  lockedProject = lib.findFirst (
    package: package.name == pyproject.project.name
  ) (throw "uv.lock does not contain ${pyproject.project.name}") lock.package;
  # uv has already parsed and normalized the root project's requirements.
  # New platform markers must be mapped deliberately, never silently dropped.
  markers = {
    "sys_platform == 'darwin'" = stdenv.hostPlatform.isDarwin;
  };
  enabled =
    dependency:
    !(dependency ? marker)
    || markers.${dependency.marker}
      or (throw "Unsupported dotfiles-python dependency marker: ${dependency.marker}");
  dependencyOverrides = {
    cyclopts = python314Packages.cyclopts.overridePythonAttrs (_previous: {
      version = "5.1.1";
      src = fetchFromGitHub {
        owner = "BrianPugh";
        repo = "cyclopts";
        tag = "v5.1.1";
        hash = "sha256-kG5Vekns6jp6MeropfwogUjBrCPjqSzNzZblV24Ty8o=";
      };
      # Zsh's completion harness emits a backspace under Nix's sandbox
      disabledTests = _previous.disabledTests ++ [
        "test_e2e_option_value[zsh]"
        "test_e2e_option_value_prefix[zsh]"
        "test_e2e_descriptions[zsh]"
        "test_e2e_subcommand_named_like_path_executable[zsh]"
        "test_e2e_eq_form_option_value[zsh]"
        "test_e2e_dependent_completion[zsh]"
        "test_e2e_wire_protocol_forward_compat[zsh]"
      ];
    });
    pyobjc-framework-cocoa = python314Packages.pyobjc-framework-Cocoa;
  };
  dependencies = map (
    dependency: dependencyOverrides.${dependency.name} or python314Packages.${dependency.name}
  ) (builtins.filter enabled lockedProject.dependencies);
  application = python314Packages.buildPythonApplication {
    pname = pyproject.project.name;
    inherit (pyproject.project) version;
    pyproject = true;
    strictDeps = true;

    src = lib.fileset.toSource {
      root = repositoryRoot;
      fileset = lib.fileset.unions [
        (repositoryRoot + /pyproject.toml)
        (repositoryRoot + /uv.lock)
        (repositoryRoot + /dotfiles/.chezmoidata/catppuccin_custom.json)
        (packageRoot + /assets)
        (packageRoot + /src/workstation)
      ];
    };

    build-system = [ python314Packages.setuptools ];
    inherit dependencies;

    passthru.runtime = python314Packages.python.withPackages (_: [
      (python314Packages.toPythonModule application)
    ]);

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
  };
in
application
