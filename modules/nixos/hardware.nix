{
  pkgs,
  lib,
  config,
  ...
}:
let
  inherit (lib.attrsets) attrValues;
  inherit (lib.modules) mkIf mkMerge;
  inherit (lib.options) mkEnableOption;
  inherit (config.nixpkgs.hostPlatform) isx86_64;
in
{
  options.local.nvidia.enable = mkEnableOption "NVIDIA";
  options.local.amd.enable = mkEnableOption "AMD";

  config = mkMerge [
    (import ./config.nix {
      inherit
        attrValues
        isx86_64
        pkgs
        ;
    })
    (mkIf config.local.nvidia.enable {
      services.xserver.videoDrivers = [ "nvidia" ];

      hardware = {
        nvidia = {
          branch = "latest";
          open = true;
          modesetting.enable = true;
          powerManagement.enable = true;
          powerManagement.finegrained = true;
          moduleParams.nvidia = {
            # NVIDIA assumes that the CPU does not support PAT by default, but
            # this is effectively never the case on supported hardware.
            NVreg_UsePageAttributeTable = 1;
            # This is sometimes needed for DDC/CI support.
            # https://www.ddcutil.com/nvidia/
            NVreg_RegistryDwords = "RMUseSwI2c=0x01;RMI2cSpeed=100";
          };
        };
      };
    })
    (mkIf config.local.amd.enable {
      # HIP libraries support - many applications hard-code HIP library paths
      systemd.tmpfiles.settings.rocm =
        let
          rocmEnv = pkgs.symlinkJoin {
            name = "rocm-combined";
            paths = attrValues {
              inherit (pkgs.pkgs.rocmPackages) rocblas hipblas clr;
            };
          };
        in
        {
          "/opt/rocm"."L+".argument = toString rocmEnv;
        };

      hardware.graphics.extraPackages = attrValues {
        inherit (pkgs.rocmPackages) clr;
      };
    })
  ];
}
