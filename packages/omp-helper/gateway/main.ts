#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { relayDesktop } from "./desktop";
import * as darwinInstaller from "./installer/darwin";
import {
  cancelUpgrade,
  install,
  prepareUpgrade,
  status,
  uninstall,
} from "./installer/installer";
import { runDeadline } from "./jobs/deadline";
import { runJobs } from "./jobs/jobs";
import { exists, PROTOCOL_MAJOR, paths, VERSION } from "./state";

const COMMAND_OPTIONS = {
  "package-path": { type: "string" },
  "wayland-display": { type: "string" },
  "maintenance-token": { type: "string" },
  "wire-codec": { type: "string" },
  scope: { type: "string" },
  owner: { type: "string" },
} as const;
const USAGE =
  "Usage: omp-helper status; upgrade prepare; install|upgrade [--package-path PACKAGE_OUTPUT] [--wayland-display NAME] [--maintenance-token UUID]; upgrade cancel --maintenance-token UUID; uninstall [--maintenance-token UUID]; desktop connect; jobs --scope ID --owner OWNER";

function parseCommand() {
  return parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: COMMAND_OPTIONS,
  });
}

type Options = ReturnType<typeof parseCommand>["values"];
type Management = {
  status(): Promise<unknown>;
  prepareUpgrade(): Promise<unknown>;
  cancelUpgrade(token: string): Promise<unknown>;
  install(
    action: "install" | "upgrade",
    packagePath: string,
    display?: string,
    token?: string,
  ): Promise<unknown>;
  uninstall(token?: string): Promise<unknown>;
};
type ManagementCommand = {
  accepts(options: Options): boolean;
  run(options: Options): Promise<unknown>;
};

function managementCommands(management: Management) {
  const install = (action: "install" | "upgrade"): ManagementCommand => ({
    accepts: () => true,
    run: async (options) => {
      const packagePath =
        options["package-path"] ?? process.env.OMP_HELPER_PACKAGE_PATH;
      if (!packagePath || process.env.OMP_HELPER_PACKAGE_PATH !== packagePath)
        throw new Error(
          "Invoke the selected package's bin/omp-helper for install or upgrade",
        );
      return management.install(
        action,
        packagePath,
        options["wayland-display"],
        options["maintenance-token"],
      );
    },
  });
  const noOptions = (options: Options) => Object.keys(options).length === 0;
  return {
    status: { accepts: noOptions, run: () => management.status() },
    "upgrade prepare": { accepts: noOptions, run: () => management.prepareUpgrade() },
    "upgrade cancel": {
      accepts: (options) =>
        !!options["maintenance-token"] && Object.keys(options).length === 1,
      run: (options) => {
        const token = options["maintenance-token"];
        if (!token) throw new Error(USAGE);
        return management.cancelUpgrade(token);
      },
    },
    install: install("install"),
    upgrade: install("upgrade"),
    uninstall: {
      accepts: (options) => !options["package-path"] && !options["wayland-display"],
      run: (options) => management.uninstall(options["maintenance-token"]),
    },
  } satisfies Record<string, ManagementCommand>;
}

async function assertActivated(): Promise<void> {
  const state = paths().state;
  if (
    (await exists(join(state, "maintenance.lock"))) ||
    !(await exists(join(state, "installer.json")))
  )
    throw new Error("Helper is not activated or is undergoing maintenance");
}

async function main(): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("omp-helper supports Linux and macOS jobs");
  const management =
    process.platform === "darwin"
      ? darwinInstaller
      : { cancelUpgrade, install, prepareUpgrade, status, uninstall };
  process.umask(0o077);
  if (process.argv[2] === "deadline") {
    await runDeadline(process.argv.slice(3));
    return;
  }
  const { values, positionals } = parseCommand();
  const [action, subcommand, ...extra] = positionals;
  if (extra.length !== 0) throw new Error("Unexpected helper command arguments");
  if (
    action === "desktop" &&
    subcommand === "connect" &&
    (Object.keys(values).length === 0 ||
      (Object.keys(values).length === 1 && values["wire-codec"] === "zstd"))
  ) {
    if (process.platform !== "linux")
      throw new Error("Linux desktop access is unavailable on macOS; use Skylight");
    await assertActivated();
    await relayDesktop(values["wire-codec"] === "zstd");
    return;
  }
  if (
    action === "jobs" &&
    subcommand === undefined &&
    values.scope &&
    values.owner &&
    !values["package-path"] &&
    !values["wayland-display"] &&
    !values["maintenance-token"] &&
    !values["wire-codec"]
  ) {
    await assertActivated();
    await runJobs(values.scope, values.owner);
    return;
  }
  if (
    (subcommand !== undefined &&
      !(
        action === "upgrade" &&
        (subcommand === "prepare" || subcommand === "cancel")
      )) ||
    values.scope ||
    values.owner
  )
    throw new Error("Invalid helper management arguments");
  if (values["wire-codec"])
    throw new Error("wire-codec is only valid for desktop connect");
  const commands = managementCommands(management);
  const key = [action, subcommand].filter((part) => part !== undefined).join(" ");
  if (!Object.hasOwn(commands, key)) throw new Error(USAGE);
  const command = commands[key as keyof typeof commands];
  if (!command.accepts(values)) throw new Error(USAGE);
  const result = await command.run(values);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ status: "error", protocolMajor: PROTOCOL_MAJOR, version: VERSION, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
