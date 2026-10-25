{
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (pkgs)
    formats
    kanata-with-cmd
    linkFarm
    rsync
    writeText
    ;
  app = "/Applications/Kanata.app";
  executable = "${app}/Contents/MacOS/kanata";
  configFile = ../../../../home/files/.config/kanata/kanata-macos.kbd;
  driverRoot = "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice";
  driver = "Karabiner-VirtualHIDDevice-Daemon";
  manager = "/Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Manager";
  driverVersion = lib.head (
    lib.match ".*Device-([0-9.]+)[.]pkg" (lib.importJSON ../../../../flake.lock)
    .nodes.source-karabiner-vhid-package.locked.url
  );
  # installer requires a .pkg filename, unlike the flake's raw source path
  driverFilename = "karabiner-vhid-${driverVersion}.pkg";
  driverPackages = linkFarm "karabiner-vhid-${driverVersion}" {
    ${driverFilename} = inputs.source-karabiner-vhid-package.outPath;
  };
  driverPackage = "${driverPackages}/${driverFilename}";
  info = (formats.plist { }).generate "kanata-info.plist" {
    CFBundleDisplayName = "Kanata";
    CFBundleExecutable = "kanata";
    CFBundleIdentifier = "dev.4evy.kanata";
    CFBundleName = "Kanata";
    CFBundlePackageType = "APPL";
    CFBundleShortVersionString = "1.0";
    CFBundleVersion = "1";
    LSUIElement = true;
  };
  # Nix libraries carry different signatures from Kanata's local identity
  entitlements = (formats.plist { }).generate "kanata-entitlements.plist" {
    "com.apple.security.cs.disable-library-validation" = true;
  };
  bundle = linkFarm "kanata-app" {
    "Contents/Info.plist" = info;
    "Contents/MacOS/kanata" = lib.getExe kanata-with-cmd;
  };
  launcher = writeText "kanata-start" ''
    set -eu
    until /usr/sbin/ioreg -r -c IOHIDDevice -l -w 0 \
      | /usr/bin/grep -Fq '"Product" = "Pebble K380s"'; do
      /bin/sleep 1
    done
    /bin/wait4path ${lib.escapeShellArg executable}
    # Configure the keyboard before Kanata opens it exclusively
    PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
      /opt/homebrew/bin/bun ${./logitech.ts} \
      --product-id 0xB377 --product-name 'Pebble K380s' --platform 0 || true
    exec ${
      lib.escapeShellArgs [
        executable
        "--no-wait"
        "--cfg"
        configFile
      ]
    }
  '';
in
{
  launchd.daemons = {
    karabiner-vhid = {
      enable = true;
      config = {
        Label = "org.pqrs.service.daemon.Karabiner-VirtualHIDDevice-Daemon";
        ProgramArguments = [ "${driverRoot}/Applications/${driver}.app/Contents/MacOS/${driver}" ];
        UserName = "root";
        RunAtLoad = true;
        KeepAlive = true;
        ProcessType = "Interactive";
        StandardOutPath = "/var/log/karabiner/virtual_hid_device_service.log";
        StandardErrorPath = "/var/log/karabiner/virtual_hid_device_service.log";
      };
    };
    kanata = {
      enable = true;
      # Apple's shell keeps macOS privacy checks attributed to Kanata
      config.ProgramArguments = [
        "/bin/sh"
        "${launcher}"
      ];
      config = {
        Label = "dev.4evy.kanata";
        RunAtLoad = true;
        KeepAlive = {
          Crashed = true;
          SuccessfulExit = false;
        };
        ProcessType = "Interactive";
        StandardOutPath = "/var/log/kanata.log";
        StandardErrorPath = "/var/log/kanata.log";
      };
    };
  };

  system = {
    build.kanataApp = bundle;

    activation.steps = {
      keyboard-driver = {
        deps = [ "homebrew" ];
        text = ''
          if ! installed=$(/usr/sbin/pkgutil --pkg-info org.pqrs.Karabiner-DriverKit-VirtualHIDDevice 2>/dev/null \
            | /usr/bin/awk '/^version:/ { print $2 }'); then
            installed=
          fi
          if [ "$installed" != ${lib.escapeShellArg driverVersion} ]; then
            /usr/sbin/installer -pkg ${driverPackage} -target /
          fi
          ${lib.escapeShellArg manager} forceActivate
          /bin/mkdir -p /var/log/karabiner
        '';
      };

      # Copy and sign the updated Nix executable at a stable path to
      # retain macOS input permissions
      keyboard-app = {
        deps = [ "keyboard-driver" ];
        text = ''
          /bin/mkdir -p ${lib.escapeShellArg app}
          kanata_changes=$(${lib.getExe rsync} --recursive --checksum --perms --links \
            --copy-unsafe-links --chmod=u+w --itemize-changes \
            ${bundle}/ ${lib.escapeShellArg "${app}/"})
          PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
            /opt/homebrew/bin/bun ${../codesign.ts} \
            ${lib.escapeShellArg app} --administrator-trust --entitlements ${entitlements}
          if [ -n "$kanata_changes" ]; then
            /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
              -f ${lib.escapeShellArg app}
            /bin/launchctl kill SIGTERM system/dev.4evy.kanata 2>/dev/null || true
          fi
        '';
      };
      launchd.deps = [ "keyboard-app" ];
    };
  };
}
