import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import { assertNativeApplication } from "./applications";
import { populated, stop } from "./processes";
import { SOURCE_HASH } from "./protocol";
import type { Lease } from "./types";
import { trackWindow } from "./windows";

const PRIVATE_SESSION_VARIABLES = [
  "DISPLAY",
  "XDG_ACTIVATION_TOKEN",
  "DESKTOP_STARTUP_ID",
  "WAYLAND_SOCKET",
] as const;

// Rust owns leases; this adapter invokes Mutter and emergency systemd operations
export class WorkspaceLeases {
  readonly leases = new Map<string, Lease>();
  constructor(
    private manager: Gio.DBusConnection,
    private settings: Gio.Settings,
  ) {}

  stop(lease: Lease) {
    stop(this.manager, lease);
  }

  prerequisite() {
    if (!global.context.get_wayland_compositor())
      throw new Error("Wayland GNOME 50 is required");
    if (this.settings.get_boolean("dynamic-workspaces"))
      throw new Error("OMP isolation requires static GNOME workspaces");
    if (this.settings.get_boolean("workspaces-only-on-primary"))
      throw new Error("OMP isolation requires workspaces on every monitor");
    if (
      !GLib.find_program_in_path("setsid") ||
      !GLib.find_program_in_path("dbus-run-session")
    )
      throw new Error("setsid and dbus-run-session must be available to GNOME Shell");
  }

  inspect() {
    this.prerequisite();
    return JSON.stringify({
      backend: "gnome-mutter-workspace",
      sourceSha256: SOURCE_HASH,
      activeWorkspace: global.workspace_manager.get_active_workspace_index(),
      focusedWindow: global.display.focus_window?.get_stable_sequence() ?? null,
      leases: [...this.leases].map(([id, lease]) => ({
        id,
        workspace: lease.workspace.index(),
        pid: lease.pid,
        exited: lease.exited,
        released: lease.released,
        windows: [...lease.windows].map((window) => ({
          id: window.get_stable_sequence(),
          workspace: window.get_workspace()?.index() ?? null,
          transientFor: window.get_transient_for()?.get_stable_sequence() ?? null,
          pid: window.get_pid(),
        })),
      })),
    });
  }

  busy() {
    return [...this.leases.values()].filter(
      (lease) => !lease.exited || lease.windows.size > 0 || populated(lease),
    ).length;
  }

  track(window: Meta.Window) {
    trackWindow(window, this.leases, (id, lease) => this.remove(id, lease));
  }

  launch(
    id: string,
    argv: string[],
    environment: Record<string, string>,
    cwd: string,
    invocation: Gio.DBusMethodInvocation,
    fds: number[] = [],
  ) {
    this.prerequisite();
    if (!/^[0-9a-f-]{36}$/.test(id) || this.leases.has(id) || argv.length === 0)
      throw new Error("Invalid or reused workspace lease");
    assertNativeApplication(argv);
    const helper = environment.OMP_WORKSPACE_HELPER;
    if (
      !helper ||
      !GLib.path_is_absolute(helper) ||
      !GLib.file_test(helper, GLib.FileTest.IS_EXECUTABLE)
    )
      throw new Error("Rust workspace helper executable is required");
    const manager = global.workspace_manager;
    const workspace = manager.append_new_workspace(false, global.get_current_time());
    try {
      const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
      for (const [key, value] of Object.entries(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          throw new Error("Invalid environment variable");
        launcher.setenv(key, value, true);
      }
      // No borrowed input serial, X11 fallback, or existing session-bus app
      for (const key of PRIVATE_SESSION_VARIABLES) launcher.unsetenv(key);
      launcher.setenv("GDK_BACKEND", "wayland", true);
      launcher.setenv("QT_QPA_PLATFORM", "wayland", true);
      if (cwd) launcher.set_cwd(cwd);
      if (fds.length) {
        if (fds.length !== 3)
          throw new Error("Expected stdin, stdout and stderr descriptors");
        const list = invocation.get_message().get_unix_fd_list();
        if (!list) throw new Error("Missing file descriptors");
        // Meta.WaylandClient reserves descriptor 3 for the Wayland socket
        for (let index = 0; index < 3; index++)
          launcher.take_fd(list.get(fds[index]), index);
      }
      const client = Meta.WaylandClient.new_subprocess(global.context, launcher, [
        helper,
        "workspace-child",
        id,
        "--",
        ...argv,
      ]);
      const process = client.get_subprocess();
      const pid = Number(process.get_identifier());
      const lease: Lease = {
        id,
        owner: invocation.get_sender(),
        workspace,
        client,
        process,
        pid,
        unit: `omp-gui-${id}.scope`,
        ready: false,
        windows: new Set(),
        exited: false,
        status: 0,
        released: false,
        cgroup: null,
      };
      this.leases.set(id, lease);
      process.wait_async(null, (_child, result) => {
        const child = process;
        child.wait_finish(result);
        lease.exited = true;
        lease.status = child.get_if_exited()
          ? child.get_exit_status()
          : 128 + child.get_term_sig();
        if (lease.released) this.remove(id, lease);
      });
      invocation.return_value(new GLib.Variant("(u)", [pid]));
    } catch (error) {
      if (
        workspace.list_windows().length === 0 &&
        manager.get_active_workspace() !== workspace
      )
        manager.remove_workspace(workspace, global.get_current_time());
      throw error;
    }
  }

  owned(id: string, invocation: Gio.DBusMethodInvocation) {
    const lease = this.leases.get(id);
    if (!lease || lease.owner !== invocation.get_sender())
      throw new Error("Workspace lease is missing or belongs to another connection");
    return lease;
  }

  remove(id: string, lease: Lease) {
    if (!lease.exited || lease.windows.size !== 0 || populated(lease)) return false;
    const manager = global.workspace_manager;
    // Never delete the user's active workspace or one with unrelated windows
    if (manager.get_workspace_by_index(lease.workspace.index()) === lease.workspace) {
      if (
        lease.workspace.list_windows().length ||
        manager.get_active_workspace() === lease.workspace
      )
        return false;
      manager.remove_workspace(lease.workspace, global.get_current_time());
    }
    this.leases.delete(id);
    return true;
  }
}
