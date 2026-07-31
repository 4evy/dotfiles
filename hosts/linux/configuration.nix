{
  config,
  dotfilesPackages,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.local.user) group home name;

  dotfilesFontconfig = pkgs.linkFarm "dotfiles-fontconfig" [
    {
      name = "etc/fonts/conf.d/45-interface-fonts.conf";
      path = ../../dotfiles/dot_config/fontconfig/conf.d/45-interface-fonts.conf;
    }
    {
      name = "etc/fonts/conf.d/50-code-monospace.conf";
      path = ../../dotfiles/dot_config/fontconfig/conf.d/50-code-monospace.conf;
    }
  ];

  systemRunnerLink = "${home}/.local/bin/system-runner";
  systemRunnerNix = "${dotfilesPackages.system-runner}/bin/system-runner";
in
{
  imports = [
    ./hardware-configuration.nix
  ];

  boot = {
    kernelPackages = pkgs.linuxPackages_latest;
    loader = {
      efi.canTouchEfiVariables = true;
      systemd-boot = {
        enable = true;
        bootCounting.enable = true;
        configurationLimit = 10;
        editor = false;
      };
    };
  };

  environment = {
    systemPackages = (
      lib.attrsets.attrValues {
        inherit (pkgs)
          firefox
          libreoffice
          prismlauncher
          rustdesk-flutter
          ;
        inherit (pkgs.unstable) jq;
      }
    );

    etc =
      (lib.attrsets.mapAttrs' (
        name: value: lib.attrsets.nameValuePair "nix/path/${name}" { source = value.flake; }
      ) config.nix.registry)
      // {
        "xdg/autostart/1password.desktop".source = ../../dotfiles/dot_config/autostart/1password.desktop;
      };
  };

  fonts = {
    fontconfig = {
      confPackages = [ dotfilesFontconfig ];
      defaultFonts = {
        sansSerif = [
          "Noto Sans"
          "Noto Sans CJK JP"
          "Noto Color Emoji"
        ];
        serif = [
          "Noto Serif"
          "Noto Serif CJK JP"
          "Noto Color Emoji"
        ];
        monospace = [
          "JetBrainsMono Nerd Font Mono"
          "Noto Sans Mono"
          "Symbols Nerd Font Mono"
          "Noto Color Emoji"
        ];
        emoji = [ "Noto Color Emoji" ];
      };
    };
    packages = with pkgs; [
      noto-fonts
      noto-fonts-cjk-sans
      noto-fonts-cjk-serif
      noto-fonts-color-emoji
      nerd-fonts.symbols-only
    ];
  };

  hardware = {
    bluetooth = {
      enable = true;
      powerOnBoot = true;
    };

    nvidia.prime = {
      reverseSync.enable = true;
      amdgpuBusId = "PCI:6:0:0";
      nvidiaBusId = "PCI:1:0:0";
    };
  };

  i18n = {
    defaultLocale = "en_US.UTF-8";
    extraLocaleSettings = {
      LC_ADDRESS = "en_US.UTF-8";
      LC_IDENTIFICATION = "en_US.UTF-8";
      LC_MEASUREMENT = "en_US.UTF-8";
      LC_MONETARY = "en_US.UTF-8";
      LC_NAME = "en_US.UTF-8";
      LC_NUMERIC = "en_US.UTF-8";
      LC_PAPER = "en_US.UTF-8";
      LC_TELEPHONE = "en_US.UTF-8";
      LC_TIME = "en_US.UTF-8";
    };
  };

  networking = {
    hostName = "nixos";
    networkmanager = {
      ensureProfiles.environmentFiles = [
        config.sops.secrets."networkmanager-environment".path
      ];
      ensureProfiles.profiles = {
        "2ghz" = {
          connection = {
            id = "2ghz";
            type = "wifi";
          };
          ipv4.method = "auto";
          wifi = {
            mode = "infrastructure";
            ssid = "2ghz";
          };
          wifi-security = {
            key-mgmt = "wpa-psk";
            psk = "$PSK_HOME";
          };
        };
        "5ghz" = {
          connection = {
            id = "5ghz";
            type = "wifi";
            autoconnect = true;
            autoconnect-priority = 100;
          };
          ipv4.method = "auto";
          wifi = {
            mode = "infrastructure";
            ssid = "5ghz";
          };
          wifi-security = {
            key-mgmt = "wpa-psk";
            psk = "$PSK_HOME";
          };
        };
      };
    };
  };

  programs = {
    _1password.enable = true;
    _1password-gui = {
      enable = true;
      polkitPolicyOwners = [ name ];
    };
  };

  security = {
    rtkit.enable = true;
    sudo.extraRules = [
      {
        users = [ name ];
        commands = [
          {
            command = systemRunnerNix;
            options = [
              "NOPASSWD"
              "SETENV"
            ];
          }
          {
            command = systemRunnerLink;
            options = [
              "NOPASSWD"
              "SETENV"
            ];
          }
        ];
      }
    ];
  };

  services = {
    xserver.enable = true;
    tailscale.enable = true;
    tailscale.package = pkgs.unstable.tailscale;

    ghidra-mcp = {
      enable = true;
      httpHost = "127.0.0.1";
      httpPort = 8089;
      mcpHost = "127.0.0.1";
      mcpPort = 8090;
      allowScripts = true;
    };

    atuin = {
      enable = true;
      port = 8888;
      openFirewall = false;
      openRegistration = false;
      host = "127.0.0.1";
      maxHistoryLength = 8192;
      database.createLocally = true;
    };

    pipewire = {
      enable = true;
      audio.enable = true;
      alsa = {
        enable = true;
        support32Bit = true;
      };
      pulse.enable = true;
      wireplumber.extraConfig = {
        # Fixes the "Corsair HS80 Wireless" Volume desync between Headset & System
        "volume-sync" = {
          "bluez5.enable-hw-volume" = false;
        };
      };
    };
  };

  sops.secrets = {
    "networkmanager-environment" = { };
    "user-password-hash".neededForUsers = true;
  };

  system.stateVersion = "25.11";

  systemd.tmpfiles.settings.dotfiles = {
    "${home}/.local/bin".d = {
      mode = "0755";
      user = name;
      inherit group;
    };
    "${systemRunnerLink}"."L+".argument = systemRunnerNix;
  };

  time.timeZone = "Europe/Sofia";

  users = {
    mutableUsers = false;
    groups.keys = {
      members = [ name ];
    };
    users = {
      ${name} = {
        isNormalUser = true;
        extraGroups = [
          "wheel"
          "network"
          "networkmanager"
          "audio"
          "keys"
        ];
        hashedPasswordFile = config.sops.secrets."user-password-hash".path;
        openssh.authorizedKeys.keys = [
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAc3DwiG6OJVICR7FQQE+I9R2447GFLrIRyF9+xP6aM5"
        ];
      };
    };
  };
}
