import Gio from "gi://Gio";
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";

const CHROMIUM_EXECUTABLE =
  /^(chrome|chromium|chromium-browser|google-chrome|google-chrome-stable|helium|helium-browser|brave|brave-browser)(-wrapped)?$/;
const FIREFOX_EXECUTABLE = /^(firefox|firefox-bin|librewolf)(-wrapped)?$/;
const NATIVE_GNOME_APPLICATIONS = [
  "loupe",
  "papers",
  "evince",
  "nautilus",
  "gnome-text-editor",
  "gedit",
  "eog",
];

export function assertNativeApplication(argv: string[]) {
  const binary = GLib.path_get_basename(argv[0]);
  const chromium = CHROMIUM_EXECUTABLE.test(binary);
  const firefox = FIREFOX_EXECUTABLE.test(binary);
  if (chromium) {
    const profiles = argv.filter((arg) => /^--user-data-dir(?:=|$)/.test(arg));
    const profile = profiles[0]?.startsWith("--user-data-dir=")
      ? profiles[0].slice(16)
      : null;
    const platforms = argv.filter((arg) => /^--ozone-platform(?:=|$)/.test(arg));
    if (
      profiles.length !== 1 ||
      !profile ||
      !GLib.path_is_absolute(profile) ||
      platforms.length !== 1 ||
      platforms[0] !== "--ozone-platform=wayland"
    )
      throw new Error(
        "Chromium requires an absolute dedicated --user-data-dir and --ozone-platform=wayland",
      );
    if (
      Gio.File.new_for_path(`${profile}/SingletonLock`).query_exists(null) ||
      GLib.file_test(`${profile}/SingletonLock`, GLib.FileTest.IS_SYMLINK)
    )
      throw new Error(
        "Chromium profile is already in use; refusing to reuse user windows",
      );
    if (argv.some((arg) => /^--remote-debugging-pipe(?:=|$)/.test(arg)))
      throw new Error(
        "GNOME trusted Wayland clients reserve FD 3; use TCP remote debugging",
      );
    return;
  }
  if (firefox) {
    const index = argv.indexOf("--profile");
    const profile = index >= 0 ? argv[index + 1] : null;
    if (
      !profile ||
      !GLib.path_is_absolute(profile) ||
      !argv.includes("--no-remote") ||
      argv.filter((arg) => /^--?profile(?:=|$)/i.test(arg)).length !== 1 ||
      argv.some((arg) => /^(-P|--?remote(?:=|$))/.test(arg))
    )
      throw new Error(
        "Firefox requires --no-remote and an absolute dedicated --profile",
      );
    if (
      GLib.file_test(`${profile}/.parentlock`, GLib.FileTest.EXISTS) ||
      GLib.file_test(`${profile}/parent.lock`, GLib.FileTest.IS_SYMLINK)
    )
      throw new Error("Firefox profile is already in use");
    return;
  }
  // These native GNOME applications use GApplication on the private bus
  if (!NATIVE_GNOME_APPLICATIONS.includes(binary))
    throw new Error(
      "Unknown GUI executable: no reliable new-instance isolation contract",
    );
}

export function uriArguments(uri: string, profile: string): string[] {
  const scheme = GLib.uri_parse_scheme(uri);
  if (!scheme) throw new Error("URI has no scheme");
  const app =
    scheme === "file"
      ? Gio.AppInfo.get_default_for_type(
          Gio.File.new_for_uri(uri)
            .query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, null)
            .get_content_type() ?? "application/octet-stream",
          false,
        )
      : Gio.AppInfo.get_default_for_uri_scheme(scheme);
  if (!(app instanceof GioUnix.DesktopAppInfo))
    throw new Error("No native desktop handler for this URI");
  const command = app.get_commandline();
  if (
    app.get_boolean("Terminal") ||
    !command ||
    /\b(flatpak|snap|xdg-open|gio)\b/.test(command)
  )
    throw new Error("URI handler needs a native isolated launch");
  const [valid, words] = GLib.shell_parse_argv(command);
  if (!valid || !words) throw new Error("Invalid desktop Exec command");
  let supplied = false;
  const argv = words.flatMap((word) => {
    if (word === "%u" || word === "%U") {
      supplied = true;
      return [uri];
    }
    if (word === "%f" || word === "%F") {
      const path = Gio.File.new_for_uri(uri).get_path();
      if (!path) throw new Error("URI handler only accepts local files");
      supplied = true;
      return [path];
    }
    if (word === "%i") return [];
    if (word === "%c") return [app.get_name()];
    if (word === "%k") {
      const filename = app.get_filename();
      if (!filename) throw new Error("Desktop handler has no filename");
      return [filename];
    }
    if (/%[^%]/.test(word)) throw new Error("Unsupported desktop Exec field code");
    return [word.replaceAll("%%", "%")];
  });
  if (!supplied) argv.push(uri);
  const binary = GLib.path_get_basename(argv[0]);
  if (CHROMIUM_EXECUTABLE.test(binary))
    argv.splice(
      1,
      0,
      `--user-data-dir=${profile}`,
      "--ozone-platform=wayland",
      "--no-first-run",
    );
  else if (FIREFOX_EXECUTABLE.test(binary))
    argv.splice(1, 0, "--no-remote", "--profile", profile);

  return argv;
}
