{
  dotfilesPackages,
  lib,
  pkgs,
  ...
}:
let
  # Import the rootfs once. Taking each local file as an independent Nix path
  # would create another single-file store object for every shared policy.
  rootfs = builtins.path {
    path = ../../bluebuild/files/system;
    name = "spectrum-rootfs";
  };

  # System and user units, native drop-ins, and their shared canonical policy
  # files stay one tree consumed directly by both NixOS and BlueBuild.
  spectrumSystemdUnits = pkgs.runCommandLocal "spectrum-systemd-units" { } ''
    mkdir -p "$out/lib/systemd"
    ln -s ${rootfs}/usr/lib/systemd/* "$out/lib/systemd/"
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

  fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];

  services = {
    # The system daemon still supplies ancestor allocations to whichever user
    # owns the active graphical session. Spectrum's shared user-unit drop-in
    # keeps the separate --user app-management daemon disabled by default.
    dbus.packages = [ dotfilesPackages.uresourced ];
    flatpak.enable = true;

    kmscon = {
      enable = true;
      package = dotfilesPackages.kmscon;
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
    packages = [
      dotfilesPackages.uresourced
      spectrumSystemdUnits
    ];
    services."user@".wants = [ "uresourced.service" ];
  };

  virtualisation.podman = {
    enable = true;
    dockerCompat = true;
    defaultNetwork.settings.dns_enabled = true;
  };
}
