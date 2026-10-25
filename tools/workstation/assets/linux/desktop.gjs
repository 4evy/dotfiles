const { Gio, GLib } = imports.gi;
const [operation, ...args] = ARGV;
const settings = (schema) => new Gio.Settings({ schema_id: schema });

switch (operation) {
  case "configure-gnome": {
    const shell = settings("org.gnome.shell");
    if (shell.is_writable("enabled-extensions")) {
      const obsolete = "hyper-window-tiling@flame.local";
      const replacement = "hyper-window-tiling@4evy.local";
      const enabled = shell.get_strv("enabled-extensions");
      const disabled = shell.get_strv("disabled-extensions");
      if (enabled.includes(obsolete)) {
        if (!shell.is_writable("disabled-extensions"))
          throw new Error("Cannot retire the obsolete tiling extension");
        // Both implementations remove the same keybinding names on disable
        // Wait for both to stop before allowing the replacement to register them
        shell.set_strv("disabled-extensions", [
          ...new Set([...disabled, obsolete, replacement]),
        ]);
        Gio.Settings.sync();
        const extensions = Gio.DBusProxy.new_for_bus_sync(
          Gio.BusType.SESSION,
          Gio.DBusProxyFlags.DO_NOT_AUTO_START,
          null,
          "org.gnome.Shell",
          "/org/gnome/Shell",
          "org.gnome.Shell.Extensions",
          null,
        );
        const deadline = GLib.get_monotonic_time() + 10_000_000;
        while (extensions.get_name_owner()) {
          const stopped = [obsolete, replacement].every((uuid) => {
            const [info] = extensions
              .call_sync(
                "GetExtensionInfo",
                new GLib.Variant("(s)", [uuid]),
                Gio.DBusCallFlags.NONE,
                1000,
                null,
              )
              .deep_unpack();
            // ACTIVE, DEACTIVATING and ACTIVATING still own or may add bindings
            return ![1, 7, 8].includes(info.state?.deep_unpack());
          });
          if (stopped) break;
          if (GLib.get_monotonic_time() >= deadline)
            throw new Error("Timed out stopping conflicting tiling extensions");
          GLib.usleep(50_000);
        }
      }
      shell.set_strv("enabled-extensions", [
        ...new Set([
          ...enabled.filter((extension) => extension !== obsolete),
          ...args,
        ]),
      ]);
      if (shell.is_writable("disabled-extensions"))
        shell.set_strv("disabled-extensions", [
          ...new Set([
            ...disabled.filter((extension) => !args.includes(extension)),
            obsolete,
          ]),
        ]);
    }
    const keys = settings("org.gnome.settings-daemon.plugins.media-keys");
    const binding =
      "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vicinae/";
    const bindings = keys.get_strv("custom-keybindings");
    if (keys.is_writable("custom-keybindings") && !bindings.includes(binding))
      keys.set_strv("custom-keybindings", [...bindings, binding]);
    Gio.Settings.sync();
    break;
  }
  case "theme":
  case "watch-theme": {
    const interfaceSettings = settings("org.gnome.desktop.interface");
    const report = () => {
      const scheme = interfaceSettings.get_string("color-scheme");
      const theme = scheme === "prefer-dark" ? "adw-gtk3-dark" : "adw-gtk3";
      const roots = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
      // adw-gtk3 consumes the same semantic named colors as libadwaita
      if (
        interfaceSettings.is_writable("gtk-theme") &&
        roots.some((root) =>
          GLib.file_test(
            GLib.build_filenamev([root, "themes", theme, "gtk-3.0", "gtk.css"]),
            GLib.FileTest.IS_REGULAR,
          ),
        )
      ) {
        interfaceSettings.set_string("gtk-theme", theme);
        Gio.Settings.sync();
      }
      print(scheme);
    };
    if (
      interfaceSettings.list_keys().includes("accent-color") &&
      interfaceSettings.is_writable("accent-color")
    )
      interfaceSettings.set_string("accent-color", "pink");
    Gio.Settings.sync();
    if (operation === "watch-theme") {
      interfaceSettings.connect("changed::color-scheme", report);
      report();
      new GLib.MainLoop(null, false).run();
    } else report();
    break;
  }
  case "flatpak-apps":
  case "flatpak-runtimes": {
    const Flatpak = imports.gi.Flatpak;
    const kind =
      operation === "flatpak-apps" ? Flatpak.RefKind.APP : Flatpak.RefKind.RUNTIME;
    const installations = [
      Flatpak.Installation.new_user(null),
      ...Flatpak.get_system_installations(null),
    ];
    print(
      JSON.stringify(
        installations.flatMap((installation) =>
          installation.list_installed_refs_by_kind(kind, null).map((ref) => ({
            id: ref.get_name(),
            branch: ref.get_branch(),
            arch: ref.get_arch(),
            origin: ref.get_origin(),
            installation: installation.get_id(),
          })),
        ),
      ),
    );
    break;
  }
  default:
    throw new Error(`Unknown desktop operation: ${operation}`);
}
