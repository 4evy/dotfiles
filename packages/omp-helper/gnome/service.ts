import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { uriArguments } from "./applications";
import type { WorkspaceLeases } from "./leases";
import { populated, scopePath } from "./processes";
import { errorMessage, type LaunchArguments, type OpenArguments } from "./protocol";

export class WorkspaceService {
  constructor(private workspaces: WorkspaceLeases) {}
  Inspect() {
    return this.workspaces.inspect();
  }
  Busy() {
    return this.workspaces.busy();
  }

  LaunchAsync(
    [id, argv, environment, cwd, fds]: LaunchArguments,
    invocation: Gio.DBusMethodInvocation,
  ) {
    try {
      this.workspaces.launch(id, argv, environment, cwd, invocation, fds);
    } catch (error) {
      invocation.return_dbus_error(
        "io.github.fourevy.OmpWorkspaces.Prerequisite",
        errorMessage(error),
      );
    }
  }

  OpenAsync(
    [id, uri, profile, environment]: OpenArguments,
    invocation: Gio.DBusMethodInvocation,
  ) {
    try {
      const argv = uriArguments(uri, profile);
      this.workspaces.launch(id, argv, environment, "", invocation);
    } catch (error) {
      invocation.return_dbus_error(
        "io.github.fourevy.OmpWorkspaces.Prerequisite",
        errorMessage(error),
      );
    }
  }

  StatusAsync([id]: [string], invocation: Gio.DBusMethodInvocation) {
    try {
      const lease = this.workspaces.owned(id, invocation);
      invocation.return_value(
        new GLib.Variant("(bbi)", [lease.ready, lease.exited, lease.status]),
      );
    } catch (error) {
      invocation.return_dbus_error(
        "io.github.fourevy.OmpWorkspaces.Prerequisite",
        errorMessage(error),
      );
    }
  }

  ReadyAsync([id]: [string], invocation: Gio.DBusMethodInvocation) {
    try {
      const lease = this.workspaces.leases.get(id);
      const senderName = invocation.get_sender();
      if (!senderName) throw new Error("Missing D-Bus sender");
      const sender = (
        Gio.DBus.session
          .call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            new GLib.Variant("(s)", [senderName]),
            new GLib.VariantType("(u)"),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
          )
          .deep_unpack() as [number]
      )[0];
      const cgroup = lease ? scopePath(sender, lease.unit) : null;
      if (!lease || lease.pid !== sender || !cgroup)
        throw new Error(
          "Launch child has not joined its owned cgroup-v2 process scope",
        );
      lease.cgroup = cgroup;
      if (!populated(lease)) throw new Error("Launch process scope is not populated");
      lease.ready = true;
      invocation.return_value(null);
    } catch (error) {
      invocation.return_dbus_error(
        "io.github.fourevy.OmpWorkspaces.Prerequisite",
        errorMessage(error),
      );
    }
  }

  ReleaseAsync([id]: [string], invocation: Gio.DBusMethodInvocation) {
    try {
      if (!this.workspaces.leases.has(id)) {
        invocation.return_value(new GLib.Variant("(b)", [true]));
        return;
      }
      const lease = this.workspaces.owned(id, invocation);
      lease.released = true;
      if (!lease.exited) lease.process.force_exit();
      invocation.return_value(
        new GLib.Variant("(b)", [this.workspaces.remove(id, lease)]),
      );
    } catch (error) {
      invocation.return_dbus_error(
        "io.github.fourevy.OmpWorkspaces.Prerequisite",
        errorMessage(error),
      );
    }
  }
}
