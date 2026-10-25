{
  lib,
  pkgs,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (pkgs)
    bun
    kmscon
    nerd-fonts
    runCommand
    rustdesk-flutter
    ;
  # Preserve the setup helper's relative imports in the store
  applicationsSource = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../tools/setup/applications.ts
      ../../../lib/typescript/commands.ts
      ../../../lib/typescript/errors.ts
    ];
  };
  # Import the rootfs once so shared policy files remain in one store tree
  rootfs = lib.sources.cleanSourceWith {
    src = ../../spectrum/files/system;
    name = "spectrum-rootfs";
  };

  # System and user units, native drop-ins, and their shared canonical policy
  # files stay one tree consumed directly by both NixOS and BlueBuild.
  spectrumSystemdUnits = runCommand "spectrum-systemd-units" { } ''
    mkdir -p $out/lib
    cp -rs ${rootfs}/usr/lib/systemd $out/lib/systemd
    rm -r $out/lib/systemd/system/rustdesk.service.d \
      $out/lib/systemd/system/tailscaled.service.d
    rm $out/lib/systemd/system/spectrum-rustdesk-prepare.service \
      $out/lib/systemd/system/spectrum-tailscale-policy.service
  '';
in
{
  environment.etc = {
    # BlueZ's NixOS module normally generates an empty input.conf. Spectrum's
    # source file intentionally replaces that default.
    "bluetooth/input.conf".source = lib.mkForce (rootfs + "/etc/bluetooth/input.conf");
    "modprobe.d/60-spectrum-bluetooth.conf".source =
      rootfs + "/usr/lib/modprobe.d/60-spectrum-bluetooth.conf";
    "systemd/system.conf.d/60-spectrum-resource-accounting.conf".source =
      spectrumSystemdUnits + "/lib/systemd/system.conf.d/60-spectrum-resource-accounting.conf";
    "systemd/user.conf.d/60-spectrum-resource-accounting.conf".source =
      spectrumSystemdUnits + "/lib/systemd/user.conf.d/60-spectrum-resource-accounting.conf";
    "uresourced.conf".source = rootfs + "/etc/uresourced.conf";
  };

  fonts.packages = attrValues { inherit (nerd-fonts) jetbrains-mono; };

  services = {
    # The system daemon still supplies ancestor allocations to whichever user
    # owns the active graphical session. Spectrum's shared user-unit drop-in
    # keeps the separate --user app-management daemon disabled by default.
    dbus.packages = attrValues { inherit (pkgs) uresourced; };
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
    packages = attrValues {
      inherit (pkgs) uresourced;
      inherit spectrumSystemdUnits;
    };
    services."user@".wants = [ "uresourced.service" ];
    services.rustdesk = {
      description = "RustDesk remote desktop service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      preStart = ''
        ${lib.getExe bun} ${applicationsSource}/tools/setup/applications.ts rustdesk
      '';
      environment.HOME = "/root";
      serviceConfig = {
        ExecStart = "${lib.getExe rustdesk-flutter} --service";
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
