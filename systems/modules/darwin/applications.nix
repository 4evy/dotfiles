{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (pkgs) dotfiles-typescript-tools formats stdenv;
  homebrewHelper = lib.meta.getExe' dotfiles-typescript-tools "dotfiles-homebrew";
  codesignHelper = lib.meta.getExe' dotfiles-typescript-tools "dotfiles-codesign";
  # Keep relative Brewfile imports inside the same public source closure
  homebrewSource = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../Brewfile
      ../../../data/homebrew/tools.json
    ];
  };
  homebrewUser = lib.strings.escapeShellArg config.homebrew.user;
  ghidraEntitlements = (formats.plist { }).generate "ghidra-entitlements.plist" {
    "com.apple.security.cs.disable-library-validation" = true;
  };
in
{
  environment.system.packages = lib.attrsets.attrValues {
    inherit (inputs.self.packages.${stdenv.hostPlatform.system}) dotfiles-apps;
  };

  homebrew = {
    enable = true;
    extra.config = ''
      instance_eval(File.read("${homebrewSource}/Brewfile"), "${homebrewSource}/Brewfile")
    '';
    on.activation = {
      auto.update = false;
      upgrade = false;
      cleanup = "none";
    };
  };

  system.activation.steps = {
    homebrew = {
      deps = lib.modules.mkForce [ "users" ];
      functions = ''
        dotfiles_homebrew_mode=no-upgrade
        dotfiles_homebrew_askpass=
        dotfiles_homebrew_password=
        # Setup opens this dedicated pipe after sudo, before ndw clears the environment
        if [[ -p /dev/fd/8 ]] &&
          IFS= read -r -n 21 -t 1 dotfiles_homebrew_header <&8 &&
          [[ $dotfiles_homebrew_header == dotfiles-homebrew-v1 ]]; then
          if ! IFS= read -r -n 11 -t 1 dotfiles_homebrew_mode <&8 ||
            ! IFS= read -r -d "" -t 1 dotfiles_homebrew_askpass <&8 ||
            ! IFS= read -r -d "" -t 1 dotfiles_homebrew_password <&8; then
            printf 'Incomplete dotfiles Homebrew activation options\n' >&2
            exit 1
          fi
          exec 8<&-
          case "$dotfiles_homebrew_mode" in
            no-upgrade|upgrade) ;;
            *)
              printf 'Invalid dotfiles Homebrew activation mode\n' >&2
              exit 1
              ;;
          esac
        fi
      '';
      text = lib.modules.mkForce ''
        (
          if [[ -n $dotfiles_homebrew_askpass ]]; then
            export SUDO_ASKPASS="$dotfiles_homebrew_askpass"
            export DOTFILES_SUDO_PASSWORD="$dotfiles_homebrew_password"
          fi
          set -- bundle --prefix ${lib.strings.escapeShellArg config.homebrew.prefix} \
            --file ${config.system.build.brewfile} --user ${homebrewUser}
          if [[ $dotfiles_homebrew_mode == upgrade ]]; then
            set -- "$@" --upgrade
          fi
          ${homebrewHelper} "$@"
        )
        unset dotfiles_homebrew_askpass dotfiles_homebrew_password
      '';
    };

    dotfiles-applications = {
      deps = [
        "applications"
        "homebrew"
      ];
      text = ''
        if [ -d '/Applications/Nix Apps/Ghidra.app' ]; then
          PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
            ${codesignHelper} \
            '/Applications/Nix Apps/Ghidra.app' --entitlements ${ghidraEntitlements}
        fi
        for name in Helium Raycast; do
          source="/Applications/Nix Apps/$name.app"
          target="/Applications/$name.app"
          if [ -e "$target" ] && [ ! -L "$target" ]; then
            printf 'Expected a managed application symlink at %s\n' "$target" >&2
            exit 1
          fi
          /bin/ln -sfn "$source" "$target"
          /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
            -f "$source"
          /usr/bin/mdimport -i "$source"
        done
      '';
    };
    launchd.deps = [ "dotfiles-applications" ];
    extra.deps = [ "dotfiles-applications" ];
  };
}
