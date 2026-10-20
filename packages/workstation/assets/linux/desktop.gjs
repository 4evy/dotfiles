const { Gio, GLib } = imports.gi;
const [operation, ...args] = ARGV;
const settings = (schema) => new Gio.Settings({ schema_id: schema });

switch (operation) {
  case "configure-gnome": {
    const shell = settings("org.gnome.shell");
    if (shell.is_writable("enabled-extensions")) {
      const enabled = shell.get_strv("enabled-extensions");
      shell.set_strv("enabled-extensions", [...new Set([...enabled, ...args])]);
      if (shell.is_writable("disabled-extensions"))
        shell.set_strv(
          "disabled-extensions",
          shell
            .get_strv("disabled-extensions")
            .filter((extension) => !args.includes(extension)),
        );
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
