import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import { WorkspaceLeases } from "./leases";
import { PATH, XML } from "./protocol";
import { WorkspaceService } from "./service";

export default class OmpWorkspaces extends Extension {
  private workspaces!: WorkspaceLeases;
  private manager!: Gio.DBusConnection;
  private service!: Gio.DBusExportedObject;
  private created = 0;
  private ownerWatch = 0;
  private sweep = 0;

  enable() {
    const uid = new Gio.Credentials().get_unix_user();
    this.manager = Gio.DBusConnection.new_for_address_sync(
      `unix:path=/run/user/${uid}/bus`,
      Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
        Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
      null,
      null,
    );
    this.workspaces = new WorkspaceLeases(
      this.manager,
      new Gio.Settings({ schema_id: "org.gnome.mutter" }),
    );
    this.created = global.display.connect("window-created", (_display, window) =>
      this.workspaces.track(window),
    );
    this.service = Gio.DBusExportedObject.wrapJSObject(
      XML,
      new WorkspaceService(this.workspaces),
    );
    this.service.export(Gio.DBus.session, PATH);
    this.ownerWatch = Gio.DBus.session.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_bus, _sender, _path, _iface, _signal, parameters) => {
        const [name, , owner] = parameters.deep_unpack() as [string, string, string];
        if (!owner) {
          for (const lease of this.workspaces.leases.values()) {
            if (lease.owner === name) {
              // Disconnect is an emergency stop, never an unisolated handoff
              this.workspaces.stop(lease);
              lease.released = true;
            }
          }
        }
      },
    );
    this.sweep = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      for (const [id, lease] of this.workspaces.leases) {
        if (lease.released) this.workspaces.remove(id, lease);
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  disable() {
    // Stop clients before removing pre-map routing; no live process is handed
    // back to the public desktop with an unisolated fallback
    for (const lease of this.workspaces.leases.values()) {
      lease.released = true;
      this.workspaces.stop(lease);
      this.workspaces.remove(lease.id, lease);
    }
    Gio.DBus.session.signal_unsubscribe(this.ownerWatch);
    GLib.source_remove(this.sweep);
    global.display.disconnect(this.created);
    this.service.unexport();
    this.workspaces.leases.clear();
    this.manager.close_sync(null);
  }
}
