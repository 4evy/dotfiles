{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (pkgs) dotfiles-typescript-tools formats stdenv;
  homebrewHelper = lib.getExe' dotfiles-typescript-tools "dotfiles-homebrew";
  codesignHelper = lib.getExe' dotfiles-typescript-tools "dotfiles-codesign";
  # Keep relative Brewfile imports inside the same public source closure
  homebrewSource = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../Brewfile
      ../../../data/homebrew/tools.json
    ];
  };
  homebrewPath = lib.concatStringsSep ":" [
    "/opt/homebrew/bin"
    "/opt/homebrew/sbin"
    "${config.users.users.${config.system.primary.user}.home}/.local/bin"
  ];
  ghidraEntitlements = (formats.plist { }).generate "ghidra-entitlements.plist" {
    "com.apple.security.cs.disable-library-validation" = true;
  };
in
{
  environment.system.packages = lib.attrValues {
    inherit (inputs.self.packages.${stdenv.hostPlatform.system}) dotfiles-apps;
    inherit (pkgs) ghostty-patched;
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
      deps = lib.mkForce [ "users" ];
      text = lib.mkForce ''
        (
          set -e
          trap '/usr/bin/sudo -H -u ${config.system.primary.user} ${homebrewHelper} restore' EXIT
          /usr/bin/sudo -H -u ${config.system.primary.user} \
            ${homebrewHelper} sandbox
          /bin/launchctl asuser "$(/usr/bin/id -u ${config.system.primary.user})" \
            /usr/bin/sudo --preserve-env=PATH,SUDO_ASKPASS,DOTFILES_SUDO_PASSWORD -H -u ${config.system.primary.user} \
            /usr/bin/env -u SUDO_USER -u HOMEBREW_SUDO_USER -u SSH_TTY -u HOMEBREW_SSH_TTY \
            PATH=${lib.escapeShellArg homebrewPath}:"$PATH" HOMEBREW_NO_AUTO_UPDATE=1 \
            /opt/homebrew/bin/brew bundle install --no-upgrade --file ${config.system.build.brewfile}
        )
      '';
    };

    dotfiles-applications = {
      deps = [
        "applications"
        "homebrew"
      ];
      text = ''
        PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
          ${codesignHelper} \
          '/Applications/Nix Apps/Ghostty.app'
        if [ -d '/Applications/Nix Apps/Ghidra.app' ]; then
          PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
            ${codesignHelper} \
            '/Applications/Nix Apps/Ghidra.app' --entitlements ${ghidraEntitlements}
        fi
        for name in Ghostty Helium Raycast; do
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
        private_bundle=${lib.escapeShellArg "${config.users.users.${config.system.primary.user}.home}/.config/homebrew/Brewfile.private"}
        if [ -f "$private_bundle" ]; then
          /bin/launchctl asuser "$(/usr/bin/id -u ${config.system.primary.user})" \
            /usr/bin/sudo --preserve-env=PATH,SUDO_ASKPASS,DOTFILES_SUDO_PASSWORD -H -u ${config.system.primary.user} \
            /usr/bin/env -u SUDO_USER -u HOMEBREW_SUDO_USER -u SSH_TTY -u HOMEBREW_SSH_TTY \
            PATH=${lib.escapeShellArg homebrewPath}:"$PATH" HOMEBREW_NO_AUTO_UPDATE=1 \
            /opt/homebrew/bin/brew bundle install --no-upgrade --file "$private_bundle"
        fi
      '';
    };
    launchd.deps = [ "dotfiles-applications" ];
    extra.deps = [ "dotfiles-applications" ];
  };
}
