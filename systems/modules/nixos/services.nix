{
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (pkgs)
    dotfiles-typescript-tools
    kmscon
    nerd-fonts
    rustdesk-flutter
    ;
  applicationsHelper = lib.meta.getExe' dotfiles-typescript-tools "dotfiles-applications";
  # Import the rootfs once so shared policy files remain in one store tree
  rootfs = lib.sources.cleanSourceWith {
    src = ../../spectrum/files/system;
    name = "spectrum-rootfs";
  };

  # Keep the same drop-ins as Spectrum, but resolve Fedora's /usr links into
  # the Nix store so the generated system and user unit trees can load them
  spectrumSystemdUnits = pkgs.runCommand "spectrum-systemd-units" { } ''
    cp -R ${spectrumSystemdSource} "$out"
    chmod -R u+w "$out/lib/systemd"
    while IFS= read -r -d "" link; do
      target=$(readlink "$link")
      case "$target" in
        /usr/lib/systemd/spectrum/*)
          ln -sfn "$out''${target#/usr}" "$link"
          ;;
      esac
    done < <(find "$out/lib/systemd" -type l -print0)
  '';

  spectrumSystemdSource =
    let
      usr = ../../spectrum/files/system/usr;
      units = usr + "/lib/systemd";
    in
    lib.fileset.toSource {
      root = usr;
      fileset = lib.fileset.difference units (
        lib.fileset.unions [
          # NixOS supplies its own executable and configuration directory
          (units + "/system/kmsconvt@.service.d/10-spectrum-config.conf")
          (units + "/system/rustdesk.service.d")
          (units + "/system/tailscaled.service.d")
          (units + "/system/spectrum-rustdesk-prepare.service")
          (units + "/system/spectrum-tailscale-policy.service")
        ]
      );
    };
in
{
  environment.etc = {
    # BlueZ's NixOS module normally generates an empty input.conf. Spectrum's
    # source file intentionally replaces that default.
    "bluetooth/input.conf".source = lib.modules.mkForce (rootfs + "/etc/bluetooth/input.conf");
    "modprobe.d/60-spectrum-bluetooth.conf".source =
      rootfs + "/usr/lib/modprobe.d/60-spectrum-bluetooth.conf";
    "systemd/system.conf.d/60-spectrum-resource-accounting.conf".source =
      "${spectrumSystemdUnits}/lib/systemd/system.conf.d/60-spectrum-resource-accounting.conf";
    "systemd/user.conf.d/60-spectrum-resource-accounting.conf".source =
      "${spectrumSystemdUnits}/lib/systemd/user.conf.d/60-spectrum-resource-accounting.conf";
  };

  fonts.packages = attrValues { inherit (nerd-fonts) jetbrains-mono; };

  services = {
    flatpak.enable = true;

    kmscon = {
      enable = true;
      package = kmscon;
      useXkbConfig = true;
      config = {
        hwaccel = true;
        term = "kmscon";
        "font-engine" = "freetype";
        "font-name" = "JetBrainsMono Nerd Font";
        "sb-size" = 10000;
      };
    };

    libinput.enable = true;
    openssh.enable = true;
    pcscd.enable = true;
    xserver.xkb.layout = "us";
  };

  programs.gnupg.agent = {
    enable = true;
    enableSSHSupport = false;
  };

  systemd = {
    oomd.enable = true;
    packages = [ spectrumSystemdUnits ];
    services.rustdesk = {
      description = "RustDesk remote desktop service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      preStart = ''
        ${applicationsHelper} rustdesk
      '';
      environment.HOME = "/root";
      serviceConfig = {
        ExecStart = "${lib.meta.getExe rustdesk-flutter} --service";
        Restart = "on-failure";
        KillMode = "mixed";
      };
    };
  };

  virtualisation.podman = {
    enable = true;
    defaultNetwork.settings.dns_enabled = true;
  };
}
