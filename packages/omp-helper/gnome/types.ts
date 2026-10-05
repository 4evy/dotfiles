import type Gio from "gi://Gio";
import type Meta from "gi://Meta";

export interface Lease {
  id: string;
  owner: string | null;
  workspace: Meta.Workspace;
  client: Meta.WaylandClient;
  process: Gio.Subprocess;
  pid: number;
  unit: string;
  ready: boolean;
  windows: Set<Meta.Window>;
  exited: boolean;
  status: number;
  released: boolean;
  cgroup: string | null;
}
