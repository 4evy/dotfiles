{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  inherit (pkgs) stdenv;
in
{
  _class = "darwin";

  imports = [
    ../cross/nixpkgs.nix
    ../cross/nixcord.nix
    ./upstream.nix
    ./defaults.nix
    ./keyboard.nix
    ./applications.nix
  ];

  determinateNix = {
    enable = true;
    customSettings = {
      builders-use-substitutes = true;
      extra-experimental-features = [ "parallel-eval" ];
      extra-substituters = [
        "https://devenv.cachix.org"
        "https://euvlok.cachix.org"
        "https://eupkgs.cachix.org"
        "https://nix-community.cachix.org"
        "https://cache.flox.dev"
      ];
      extra-trusted-public-keys = [
        "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
        "euvlok.cachix.org-1:cmFWCSs7rxPiyE1qfaJn8TY7QaRoGOrzKuNvtGw2gcU="
        "eupkgs.cachix.org-1:V9Y0HdASNNSU9U6EkXhR1j85bZGRtNgW7wSyTiQrwGU="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
        "flox-cache-public-1:7F4OyH7ZCnFhcze3fJdfyXYLQw/aV7GEed86nQ7IsOs="
      ];
    };
    determinateNixd.builder.state = "disabled";
  };

  users.users.${config.system.primary.user}.shell = "/opt/homebrew/bin/zsh";
  programs = {
    nixcord.user = config.system.primary.user;
    bash = {
      enable = true;
      package = null;
      completion.enable = false;
    };
    zsh = {
      enable = true;
      package = null;
      completion.enable = false;
      env.extra = ''
        if [ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ] && [ -n "''${SSH_CONNECTION:-}" ] && [ "''${SHLVL:-0}" -eq 1 ]; then
          . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
        fi
      '';
    };
  };
  environment = {
    system.packages = lib.attrValues {
      inherit (inputs.hjem.packages.${stdenv.hostPlatform.system}) hjem;
      inherit (inputs.self.packages.aarch64-darwin) dotfiles-nix-tools dotfiles-workstation;
    };
    files.shells = {
      known.macOS = true;
      text = ''
        /bin/bash
        /bin/csh
        /bin/dash
        /bin/ksh
        /bin/sh
        /bin/tcsh
        /bin/zsh
        /opt/homebrew/bin/bash
        /opt/homebrew/bin/zsh
      '';
    };
  };

  # Homebrew keeps ownership of its installed daemon and mutable state
  launchd.daemons.tailscale-ssh = {
    enable = true;
    config = {
      Label = "dev.4evy.tailscale-ssh";
      ProgramArguments = [
        "/opt/homebrew/bin/tailscale"
        "set"
        "--ssh=true"
      ];
      RunAtLoad = true;
      KeepAlive = {
        Crashed = true;
        SuccessfulExit = false;
      };
      ThrottleInterval = 2;
      ProcessType = "Background";
      StandardOutPath = "/var/log/tailscale-ssh.log";
      StandardErrorPath = "/var/log/tailscale-ssh.log";
    };
  };

  system.activation.steps.tailscale = {
    deps = [ "homebrew" ];
    text = ''
      if ! /bin/launchctl print system/homebrew.mxcl.tailscale >/dev/null 2>&1; then
        HOMEBREW_CACHE=$(/usr/bin/sudo -H -u ${config.system.primary.user} /opt/homebrew/bin/brew --cache) \
          /opt/homebrew/bin/brew services start tailscale
      fi
    '';
  };
  system.activation.steps.launchd.deps = [ "tailscale" ];
}
