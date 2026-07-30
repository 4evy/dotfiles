{
  attrValues,
  isx86_64,
  pkgs,
}:
{
  # General hardware configuration
  environment.systemPackages = attrValues { inherit (pkgs) libva-utils; };
  environment.sessionVariables = {
    # It tells supported apps to use the Ozone/Wayland backend
    NIXOS_OZONE_WL = "1";

    # Improve compatibility for older Java GUI (AWT/Swing) apps, especially on
    # non-reparenting WMs (most Wayland compositors, some X11 WMs)
    _JAVA_AWT_WM_NONREPARENTING = "1";

    # Enable automatic scaling for Qt5/Qt6 applications based on monitor DPI
    # Useful for HiDPI displays
    QT_AUTO_SCREEN_SCALE_FACTOR = "1";

    # Enable Variable Refresh Rate (VRR/FreeSync) for OpenGL and GLX
    __GL_VRR_ALLOWED = "1";
    __GLX_VRR_ALLOWED = "1";
  };

  hardware.graphics = {
    enable = true;
    enable32Bit = isx86_64;
  };

  # Spectrum installs Solaar and its udev support for the shared Logitech
  # rules and user service. Use the NixOS hardware module for the same
  # package and device permissions.
  hardware.logitech.wireless = {
    enable = true;
    enableGraphical = true;
  };
}
