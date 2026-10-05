import Meta from "gi://Meta";
import { scopePath } from "./processes";
import type { Lease } from "./types";

function belongs(window: Meta.Window, lease: Lease) {
  if (window.get_client_type() !== Meta.WindowClientType.WAYLAND) return false;
  if (lease.client.owns_window(window)) return true;
  return scopePath(window.get_pid(), lease.unit) !== null;
}

export function trackWindow(
  window: Meta.Window,
  leases: ReadonlyMap<string, Lease>,
  remove: (id: string, lease: Lease) => boolean,
) {
  for (const lease of leases.values()) {
    const parent = window.get_transient_for();
    if (!(parent !== null && lease.windows.has(parent)) && !belongs(window, lease))
      continue;
    lease.windows.add(window);
    const assign = () => {
      window.unstick();
      if (window.get_workspace() !== lease.workspace)
        window.change_workspace(lease.workspace);
    };
    // window-created is emitted before Mutter's queued map/focus decision
    assign();
    window.connect("workspace-changed", assign);
    window.connect("notify::on-all-workspaces", assign);
    window.connect("unmanaged", () => {
      lease.windows.delete(window);
      if (lease.released) remove(lease.id, lease);
    });
    return;
  }
}
