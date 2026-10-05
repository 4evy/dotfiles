import Gio from "gi://Gio";
import GLib from "gi://GLib";
import type { Lease } from "./types";

const INACTIVE_UNIT_ERRORS = [
  "org.freedesktop.systemd1.NoSuchUnit",
  "org.freedesktop.systemd1.UnitNotLoaded",
  "org.freedesktop.systemd1.UnitNotRunning",
  "org.freedesktop.systemd1.NoSuchProcess",
];

export function scopePath(pid: number, unit: string) {
  try {
    const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cgroup`);
    if (!ok) return null;
    const path = new TextDecoder()
      .decode(bytes)
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    return path?.split("/").includes(unit) ? path : null;
  } catch {
    return null;
  }
}

export function populated(lease: Lease) {
  if (!lease.cgroup) return false;
  try {
    const [ok, bytes] = GLib.file_get_contents(
      `/sys/fs/cgroup${lease.cgroup}/cgroup.events`,
    );
    return !ok || new TextDecoder().decode(bytes).includes("populated 1");
  } catch (error) {
    // Removed cgroups are empty; other failures must retain the workspace
    return !(
      error instanceof GLib.Error && error.matches(GLib.FileError, GLib.FileError.NOENT)
    );
  }
}

export function stop(manager: Gio.DBusConnection, lease: Lease) {
  // Emergency compositor shutdown/disconnect must stop the whole launch
  // session, including child clients, before removing window routing
  try {
    manager.call_sync(
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "KillUnit",
      new GLib.Variant("(ssi)", [lease.unit, "all", 9]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
    );
  } catch (error) {
    if (
      !(error instanceof GLib.Error) ||
      !INACTIVE_UNIT_ERRORS.includes(Gio.DBusError.get_remote_error(error) ?? "")
    )
      throw error;
  } finally {
    if (!lease.exited) lease.process.force_exit();
  }
}
