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
    ../shared/nixpkgs.nix
    ../shared/nixcord.nix
    ./upstream.nix
    ./defaults.nix
    ./keyboard
    ./applications.nix
  ];

  determinateNix = {
    enable = true;
    customSettings =
      (import ../../../nix/lib/cache/settings.nix {
        inherit lib;
        platform = "darwin";
      })
      // {
        builders-use-substitutes = true;
        extra-experimental-features = [ "parallel-eval" ];
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
