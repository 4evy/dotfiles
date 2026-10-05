import { dirname, join } from "node:path";
import { paths } from "../state";
export const UNIT = "omp-helper-desktop.service";
export const WORKSPACE_EXTENSION_FILES = ["extension.js", "metadata.json"];
const APP = "io.github.fourevy.OmpHelper.desktop";
export const WORKSPACE_EXTENSION = "omp-workspaces@4evy.local";
export function locations() {
  const p = paths();
  return {
    ...p,
    unit: join(p.config, "systemd/user", UNIT),
    wants: join(p.config, "systemd/user/graphical-session.target.wants", UNIT),
    descriptor: join(dirname(p.data), "applications", APP),
    environment: join(p.state, "desktop.env"),
    workspaceExtension: join(
      dirname(p.data),
      "gnome-shell/extensions",
      WORKSPACE_EXTENSION,
    ),
    record: join(p.state, "installer.json"),
    current: join(p.data, "current"),
    previous: join(p.data, "previous"),
    roots: join(p.state, "gcroots"),
    lock: join(p.state, "maintenance.lock"),
    preparation: join(p.state, "maintenance.lock", "preparation.json"),
  };
}

export type Locations = ReturnType<typeof locations>;
