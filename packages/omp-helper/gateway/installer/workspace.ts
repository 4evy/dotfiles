import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command } from "./command";
import { locations, WORKSPACE_EXTENSION } from "./locations";

const workspaceEnvelopeSchema = z.object({ data: z.tuple([z.string()]) });
const workspaceIsolationSchema = z.object({ sourceSha256: z.string() }).passthrough();
const WORKSPACE_SETTINGS_SCRIPT = `const settings = new imports.gi.Gio.Settings({schema_id: 'org.gnome.shell'});
const uuid = ARGV[0];
const previous = settings.get_strv('enabled-extensions');
const enabled = ARGV[1] === 'enable'
    ? (previous.includes(uuid) ? previous : [...previous, uuid])
    : previous.filter(value => value !== uuid);
if (JSON.stringify(previous) !== JSON.stringify(enabled) &&
    !settings.set_strv('enabled-extensions', enabled)) throw new Error('GNOME extension settings are locked');
const previousDisabled = settings.get_strv('disabled-extensions');
const disabled = previousDisabled.filter(value => value !== uuid);
if (JSON.stringify(previousDisabled) !== JSON.stringify(disabled) &&
    !settings.set_strv('disabled-extensions', disabled)) throw new Error('GNOME disabled extension settings are locked');`;

export const GNOME_SHELL_VERSION = [
  "busctl",
  "--user",
  "--json=short",
  "get-property",
  "org.gnome.Shell",
  "/org/gnome/Shell",
  "org.gnome.Shell.Extensions",
  "ShellVersion",
];
export async function workspaceExtensionEnabled(enable: boolean): Promise<void> {
  await command([
    "gjs",
    "-c",
    WORKSPACE_SETTINGS_SCRIPT,
    WORKSPACE_EXTENSION,
    enable ? "enable" : "disable",
  ]);
}

export async function workspaceIsolation() {
  const result = await command(
    [
      "busctl",
      "--user",
      "--json=short",
      "call",
      "org.gnome.Shell",
      "/io/github/fourevy/OmpWorkspaces",
      "io.github.fourevy.OmpWorkspaces1",
      "Inspect",
    ],
    true,
  );
  if (result.code !== 0)
    return {
      status: "prerequisite" as const,
      reason: `GNOME 50 workspace adapter is not active; log out and back in after installing it, with static workspaces on every monitor. ${result.stderr.trim()}`,
    };
  const envelope = workspaceEnvelopeSchema.parse(JSON.parse(result.stdout));
  const active = workspaceIsolationSchema.parse(JSON.parse(envelope.data[0]));
  const installedSource = await readFile(
    join(locations().workspaceExtension, "extension.js"),
    "utf8",
  );
  if (
    !installedSource.includes(`SOURCE_HASH = ${JSON.stringify(active.sourceSha256)};`)
  )
    return {
      status: "prerequisite" as const,
      reason:
        "GNOME is still running the previous workspace adapter; log out and back in to activate this version",
    };
  return { status: "ready" as const, backend: "gnome-mutter-workspace" };
}
