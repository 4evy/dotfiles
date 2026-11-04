import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { run } from "@dotfiles/core/commands";
import { DotfilesError, UsageError } from "@dotfiles/core/errors";
import { writeIfChanged } from "@dotfiles/core/files";
import agent from "@dotfiles/workstation/assets/macos-accent" with { type: "text" };
import { color, palettes } from "@dotfiles/workstation/theme";
import { Console, Effect, FileSystem } from "effect";
import Builder from "fast-xml-builder";
import type * as FridaApi from "frida";
import type { Cancellable, Device, Process, Script, Session } from "frida";

type Frida = typeof FridaApi;
type AccentAgent = {
  install(
    accent: string,
    cancellable: Cancellable,
  ): Promise<{
    supported: boolean;
    reason?: string;
  }>;
  dispose(cancellable: Cancellable): Promise<unknown>;
};
const label = "dev.4evy.dotfiles.macos-accent";
const marker = "<!-- Managed by dotfiles macos-catppuccin-custom-accent -->";
const usage =
  "Usage: macos-catppuccin-custom-accent --install|--uninstall|--status|--watch";

type Paths = {
  dataHome: string;
  stateHome: string;
  directory: string;
  executable: string;
  sidecar: string;
  plist: string;
  status: string;
  target: string;
  domain: string;
};

function paths(): Paths {
  const home = homedir();
  const dataHome = resolve(process.env.XDG_DATA_HOME ?? join(home, ".local/share"));
  const stateHome = resolve(process.env.XDG_STATE_HOME ?? join(home, ".local/state"));
  const directory = join(stateHome, "dotfiles/macos-accent");
  const domain = `gui/${userInfo().uid}`;
  return {
    dataHome,
    stateHome,
    directory,
    executable: join(dataHome, "dotfiles/workstation/workstation"),
    sidecar: join(dataHome, "dotfiles/workstation/frida.js"),
    plist: join(home, "Library/LaunchAgents", `${label}.plist`),
    status: join(directory, "status.json"),
    target: `${domain}/${label}`,
    domain,
  };
}
type Entry = {
  pid: number;
  name: string;
  status: "attached" | "unsupported" | "error" | "detached";
  error?: string;
};
type Status = {
  version: 1;
  label: string;
  supervisorPid: number;
  running: boolean;
  updatedAt: string;
  accent: string;
  entries: Entry[];
};
type Attachment = {
  session: Session;
  script?: Script;
  failure?: string;
  operation?: Cancellable;
  cleanup?: Promise<string[]>;
};

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n]+/g, " ")
    .slice(0, 500);
}

async function readStatus(path: string): Promise<Status | undefined> {
  let text: string;
  try {
    if (!(await lstat(path)).isFile())
      throw new Error(`Refusing unmanaged accent status: ${path}`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const status = JSON.parse(text) as Status;
  if (
    status.version !== 1 ||
    status.label !== label ||
    !Number.isInteger(status.supervisorPid)
  )
    throw new Error(`Refusing unmanaged accent status: ${path}`);
  return status;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory())
    throw new Error(`Accent state directory must not be a symlink: ${path}`);
  await chmod(path, 0o700);
}

// Only top-level application executables are eligible, never nested helpers
function mainApplication(process: Process) {
  const path = process.parameters.path;
  if (typeof path !== "string" || /\.(framework|xpc)\//.test(path)) return false;
  const bundle = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(path)?.[1];
  return bundle !== undefined && !bundle.includes(".app/");
}

function watcher(frida: Frida, location: Paths, accent: string) {
  const controller = new AbortController();
  const pending = new Set<Cancellable>();
  const attachments = new Map<number, Attachment>();
  const lifetimes = new Map<number, string>();
  const entries = new Map<number, Entry>();
  let running: Promise<void> | undefined;
  let claimed = false;
  let deviceOpened = false;

  function stop() {
    controller.abort();
    for (const cancellable of pending) cancellable.cancel();
  }

  async function native<T>(
    operation: (cancellable: Cancellable) => Promise<T>,
    timeout = 10_000,
    cleaning = false,
  ): Promise<T> {
    if (controller.signal.aborted && !cleaning)
      throw new Error("Accent watcher stopped");
    const cancellable = frida.Cancellable.withTimeout(timeout);
    pending.add(cancellable);
    try {
      return await operation(cancellable);
    } finally {
      pending.delete(cancellable);
      cancellable.cancel();
    }
  }

  function report(entry: Entry) {
    const previous = entries.get(entry.pid);
    entries.set(entry.pid, entry);
    if (previous?.status !== entry.status || previous?.error !== entry.error)
      console.error(
        `${entry.name} (${entry.pid}): ${entry.status}${entry.error ? ` — ${entry.error}` : ""}`,
      );
  }

  async function save(isRunning: boolean) {
    const status: Status = {
      version: 1,
      label,
      supervisorPid: process.pid,
      running: isRunning,
      updatedAt: new Date().toISOString(),
      accent,
      entries: [...entries.values()],
    };
    const temporary = join(location.directory, `.status-${process.pid}.json`);
    try {
      await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, location.status);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  function clean(pid: number, attachment: Attachment): Promise<string[]> {
    if (attachment.cleanup) return attachment.cleanup;
    attachment.cleanup = (async () => {
      const errors: string[] = [];
      const { session, script } = attachment;
      if (!session.isDetached()) {
        if (script && !script.isDestroyed) {
          try {
            await native(
              (cancellable) => (script.exports as AccentAgent).dispose(cancellable),
              4_000,
              true,
            );
          } catch (error) {
            errors.push(`dispose: ${message(error)}`);
          }
          try {
            await native((cancellable) => script.unload(cancellable), 4_000, true);
          } catch (error) {
            errors.push(`unload: ${message(error)}`);
          }
        }
        try {
          await native((cancellable) => session.detach(cancellable), 4_000, true);
        } catch (error) {
          errors.push(`detach: ${message(error)}`);
        }
      }
      if (session.isDetached() && attachments.get(pid) === attachment)
        attachments.delete(pid);
      if (errors.length)
        console.error(`Accent cleanup (${pid}): ${errors.join(" — ")}`);
      return errors;
    })();
    return attachment.cleanup;
  }

  async function attach(device: Device, process: Process, name: string) {
    let attachment: Attachment | undefined;
    let installed = false;
    try {
      const session = await native((cancellable) =>
        device.attach(process.pid, {}, cancellable),
      );
      attachment = { session };
      attachments.set(process.pid, attachment);
      session.detached.connect((reason) => {
        if (
          !controller.signal.aborted &&
          entries.get(process.pid)?.status === "attached"
        )
          report({ pid: process.pid, name, status: "detached", error: reason });
      });
      const script = await native((cancellable) =>
        session.createScript(agent, { name: "dotfiles-macos-accent" }, cancellable),
      );
      attachment.script = script;
      const current = attachment;
      script.message.connect((event) => {
        if (
          event.type !== frida.MessageType.Error ||
          current.failure ||
          controller.signal.aborted
        )
          return;
        current.failure = message(event.description);
        report({
          pid: process.pid,
          name,
          status: "error",
          error: current.failure,
        });
        current.operation?.cancel();
        // Retained by the attachment so shutdown also awaits runtime failures
        void clean(process.pid, current);
      });
      // Do not forward application console output or arbitrary script payloads
      script.logHandler = () => {};
      await native((cancellable) => {
        current.operation = cancellable;
        return script.load(cancellable);
      });
      const deadline = Date.now() + 10_000;
      while (!controller.signal.aborted) {
        if (current.failure) throw new Error(current.failure);
        const result = await native((cancellable) => {
          current.operation = cancellable;
          return (script.exports as AccentAgent).install(accent, cancellable);
        }, 15_000);
        if (current.failure) throw new Error(current.failure);
        if (result.supported) {
          if (session.isDetached())
            throw new Error("Process detached during accent installation");
          installed = true;
          report({ pid: process.pid, name, status: "attached" });
          break;
        }
        // A new GUI process may not have finished initializing AppKit yet
        if (
          (result.reason === "AppKit not loaded" ||
            result.reason === "AppKit not ready") &&
          Date.now() < deadline
        ) {
          await sleep(500, undefined, { signal: controller.signal });
          continue;
        }
        report({
          pid: process.pid,
          name,
          status: "unsupported",
          error: message(result.reason ?? "No supported AppKit hooks"),
        });
        break;
      }
    } catch (error) {
      if (!controller.signal.aborted)
        report({
          pid: process.pid,
          name,
          status: attachment?.failure ? "error" : "unsupported",
          error: attachment?.failure ?? message(error),
        });
    } finally {
      if (attachment && !installed) await clean(process.pid, attachment);
    }
    if (attachment && !installed && !attachment.session.isDetached())
      throw new Error(`Could not detach the failed accent session (${process.pid})`);
  }

  async function watch(signal: AbortSignal) {
    const onAbort = () => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) stop();
    running = (async () => {
      try {
        await privateDirectory(location.directory);
        const previous = await readStatus(location.status);
        if (previous?.running && alive(previous.supervisorPid))
          throw new Error(
            `Accent watcher is already running (${previous.supervisorPid})`,
          );
        claimed = true;
        await save(true);
        deviceOpened = true;
        const device = await native((cancellable) => frida.getLocalDevice(cancellable));
        const username = userInfo().username;
        while (!controller.signal.aborted) {
          const applications = await native((cancellable) =>
            device.enumerateApplications({ scope: frida.Scope.Metadata }, cancellable),
          );
          const processes = await native((cancellable) =>
            device.enumerateProcesses({ scope: frida.Scope.Full }, cancellable),
          );
          const names = new Map(
            applications
              .filter((app) => app.pid !== 0)
              .map((app) => [app.pid, app.name]),
          );
          const present = new Set(processes.map((process) => process.pid));
          for (const [pid] of lifetimes) {
            if (present.has(pid)) continue;
            const attachment = attachments.get(pid);
            if (attachment) await clean(pid, attachment);
            lifetimes.delete(pid);
            entries.delete(pid);
          }
          for (const process of processes) {
            if (controller.signal.aborted) break;
            const name = names.get(process.pid);
            if (
              process.pid === globalThis.process.pid ||
              !name ||
              !mainApplication(process)
            )
              continue;
            const owner = process.parameters.user;
            if (typeof owner === "string" && owner !== username) continue;
            const identity = `${String(process.parameters.started ?? "")}:${String(process.parameters.path)}`;
            if (lifetimes.get(process.pid) === identity) continue;
            const previousAttachment = attachments.get(process.pid);
            if (previousAttachment) await clean(process.pid, previousAttachment);
            lifetimes.set(process.pid, identity);
            if (owner !== username || typeof process.parameters.started !== "string") {
              report({
                pid: process.pid,
                name,
                status: "unsupported",
                error:
                  "Cannot establish same-user process lifetime from Frida metadata",
              });
              continue;
            }
            await attach(device, process, name);
          }
          await save(true);
          await sleep(5_000, undefined, { signal: controller.signal });
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        // The release effect waits for this path even when its use is interrupted
        await Promise.all(
          [...attachments].map(async ([pid, attachment]) => {
            const errors = await clean(pid, attachment);
            const entry = entries.get(pid);
            if (entry?.status === "attached")
              entries.set(pid, {
                ...entry,
                status: errors.length ? "error" : "detached",
                ...(errors.length ? { error: errors.join(" — ") } : {}),
              });
          }),
        );
        if (deviceOpened) {
          try {
            await native(
              (cancellable) => frida.getDeviceManager().close(cancellable),
              2_000,
              true,
            );
          } catch (error) {
            console.error(`Accent device cleanup: ${message(error)}`);
          }
        }
        if (claimed) await save(false);
      }
    })();
    try {
      await running;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    watch,
    async close() {
      stop();
      // Preserve the original failure from the use effect, after releasing hooks
      await running?.catch(() => {});
    },
  };
}

const plistBuilder = new Builder();
const plistString = (value: string) => plistBuilder.build({ string: value });

function launchAgent(location: Paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marker}
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${plistString(location.executable)}<string>macos-catppuccin-custom-accent</string><string>--watch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>Umask</key><integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>XDG_DATA_HOME</key>${plistString(location.dataHome)}
    <key>XDG_STATE_HOME</key>${plistString(location.stateHome)}
  </dict>
  <key>StandardOutPath</key>${plistString(join(location.directory, "stdout.log"))}
  <key>StandardErrorPath</key>${plistString(join(location.directory, "stderr.log"))}
</dict>
</plist>
`;
}

const ownedPlist = Effect.fn("macosAccent.ownedPlist")(function* (location: Paths) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.lstat(location.plist).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
  if (!info) return false;
  if (
    info.type !== "File" ||
    !(yield* fs.readFileString(location.plist)).includes(
      `${marker}\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>`,
    )
  )
    return yield* Effect.fail(
      new DotfilesError(`Refusing unmanaged LaunchAgent: ${location.plist}`),
    );
  return true;
});

const bootout = Effect.fn("macosAccent.bootout")(function* (location: Paths) {
  const loaded = yield* run(["/bin/launchctl", "print", location.target], {
    capture: true,
    check: false,
  });
  const previous = yield* Effect.tryPromise(() => readStatus(location.status));
  if (loaded.code !== 0) {
    if (previous?.running && alive(previous.supervisorPid))
      return yield* Effect.fail(
        new DotfilesError(
          `A manually started accent watcher (${previous.supervisorPid}) is still running`,
        ),
      );
    return;
  }
  if (
    ![location.executable, "macos-catppuccin-custom-accent", "--watch"].every(
      (argument) => loaded.stdout.includes(argument),
    )
  )
    return yield* Effect.fail(
      new DotfilesError(`Refusing to stop an unmanaged LaunchAgent using ${label}`),
    );
  yield* run(["/bin/launchctl", "bootout", location.target], { capture: true });
  if (previous?.running) {
    const deadline = Date.now() + 20_000;
    while (alive(previous.supervisorPid)) {
      if (Date.now() >= deadline)
        return yield* Effect.fail(
          new DotfilesError("Accent watcher did not stop after launchctl bootout"),
        );
      yield* Effect.sleep(100);
    }
  }
});

export const installAccent = Effect.fn("macosAccent.install")(function* () {
  if (process.platform !== "darwin") return;
  const location = paths();
  const fs = yield* FileSystem.FileSystem;
  yield* ownedPlist(location);
  yield* Effect.tryPromise(() => access(location.executable, constants.X_OK));
  yield* Effect.tryPromise(() => access(location.sidecar, constants.R_OK));
  yield* Effect.tryPromise(() => privateDirectory(location.directory));
  yield* fs.makeDirectory(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  yield* bootout(location);
  yield* writeIfChanged(location.plist, launchAgent(location), 0o600);
  yield* run(["/bin/launchctl", "bootstrap", location.domain, location.plist], {
    capture: true,
  });
  yield* Console.log(
    `Installed ${label}. Use macos-catppuccin-custom-accent --status for application support`,
  );
});

const uninstallAccent = Effect.fn("macosAccent.uninstall")(function* () {
  const location = paths();
  const fs = yield* FileSystem.FileSystem;
  const installed = yield* ownedPlist(location);
  const status = yield* Effect.tryPromise(() => readStatus(location.status));
  yield* bootout(location);
  if (installed) yield* fs.remove(location.plist);
  if (status) yield* fs.remove(location.status, { force: true });
  yield* Console.log(
    "Removed the accent LaunchAgent and its status. Relaunch applications if cached custom colors remain. Existing highlight and folder tint preferences are unchanged",
  );
});

const accentStatus = Effect.fn("macosAccent.status")(function* () {
  const location = paths();
  const installed = yield* ownedPlist(location);
  const result = yield* run(["/bin/launchctl", "print", location.target], {
    capture: true,
    check: false,
  });
  const status = yield* Effect.tryPromise(() => readStatus(location.status));
  yield* Console.log(
    JSON.stringify(
      {
        label,
        installed,
        loaded: result.code === 0,
        running: !!status?.running && alive(status.supervisorPid),
        status: status ?? null,
      },
      null,
      2,
    ),
  );
});

export const macosAccent = Effect.fn("macosAccent")(function* (args: string[]) {
  const { values } = yield* Effect.try({
    try: () =>
      parseArgs({
        args,
        options: {
          watch: { type: "boolean" },
          install: { type: "boolean" },
          uninstall: { type: "boolean" },
          status: { type: "boolean" },
        },
      }),
    catch: (error) => new UsageError(message(error)),
  });
  const options = Object.entries(values)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  if (!options.length) {
    yield* Console.log(usage);
    return 0;
  }
  if (options.length !== 1)
    return yield* Effect.fail(
      new UsageError(
        "Choose exactly one of --install, --uninstall, --status, or --watch",
      ),
    );
  if (process.platform !== "darwin")
    return yield* Effect.fail(
      new DotfilesError("Runtime AppKit accent injection is only supported on macOS"),
    );
  if (values.install) yield* installAccent();
  else if (values.uninstall) yield* uninstallAccent();
  else if (values.status) yield* accentStatus();
  else {
    const location = paths();
    const frida = yield* Effect.tryPromise({
      try: () => import(location.sidecar) as Promise<Frida>,
      catch: (cause) =>
        new DotfilesError(
          `Could not load the installed Frida sidecar: ${location.sidecar}. Reinstall workstation before starting the accent helper`,
          { cause },
        ),
    });
    yield* Effect.acquireUseRelease(
      Effect.sync(() => watcher(frida, location, color(palettes.light, "accent"))),
      (supervisor) =>
        Effect.tryPromise({
          try: (signal) => supervisor.watch(signal),
          catch: (cause) =>
            new DotfilesError(`Accent watcher failed: ${message(cause)}`, { cause }),
        }),
      (supervisor) => Effect.promise(() => supervisor.close()),
    );
  }
  return 0;
});
