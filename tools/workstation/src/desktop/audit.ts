import { freemem, loadavg, release, totalmem } from "node:os";
import { output, run } from "@dotfiles/core/commands";
import { flatpakRefs } from "@dotfiles/workstation/desktop";
import { Config, Console, Effect, FileSystem } from "effect";

function section(name: string) {
  return Console.log(`\n== ${name} ==`);
}
const printCommand = Effect.fn("desktopAudit.printCommand")(function* (args: string[]) {
  const result = yield* run(args, { check: false, capture: true });
  if (result.stdout) yield* Console.log(result.stdout.trimEnd());
  return result.stdout;
});
const available = (command: string) => Effect.sync(() => Boolean(Bun.which(command)));
const printIfAvailable = Effect.fn("desktopAudit.printIfAvailable")(function* (
  command: string,
  ...args: string[]
) {
  if (!(yield* available(command))) return false;
  yield* printCommand([command, ...args]);
  return true;
});
function matchingLines(
  text: string,
  pattern: RegExp,
  limit?: number,
  tail = false,
): string {
  const lines = text.split(/\r?\n/).filter((line) => pattern.test(line));
  return (
    limit === undefined ? lines : tail ? lines.slice(-limit) : lines.slice(0, limit)
  ).join("\n");
}
const auditSystem = Effect.fn("desktopAudit.system")(function* () {
  yield* section("system");
  yield* printIfAvailable("hostnamectl");
  yield* Console.log(
    `session=${yield* Config.String("XDG_SESSION_TYPE").pipe(Config.withDefault("unknown"))} desktop=${yield* Config.String("XDG_CURRENT_DESKTOP").pipe(Config.withDefault("unknown"))}`,
  );
  yield* Console.log(`kernel=${yield* Effect.sync(release)}`);
  for (const command of ["rpm-ostree", "bootc"])
    yield* printIfAvailable(command, "status");
});
const readText = Effect.fn("desktopAudit.readText")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(path)) ? (yield* fs.readFileString(path)).trim() : "";
});
const auditGraphics = Effect.fn("desktopAudit.graphics")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* section("graphics");
  yield* printIfAvailable("lspci", "-nnk", "-d", "::03xx");
  if (yield* fs.exists("/dev/dri")) yield* printIfAvailable("ls", "-l", "/dev/dri");
  if (yield* available("lsmod"))
    yield* Console.log(
      matchingLines(
        yield* output(["lsmod"], { check: false }),
        /^(nvidia|nouveau|amdgpu|i915)/i,
      ),
    );
  if (yield* fs.exists("/sys/class/drm"))
    for (const device of yield* fs.glob("/sys/class/drm/card[0-9]/device"))
      yield* Console.log(
        `${device} vendor=${yield* readText(`${device}/vendor`)} device=${yield* readText(`${device}/device`)}`,
      );
  yield* printIfAvailable("nvidia-smi");
  if (yield* available("rpm"))
    yield* Console.log(
      matchingLines(
        yield* output(["rpm", "-qa"], { check: false }),
        /^(nvidia|kmod-nvidia|akmod-nvidia|xorg-x11-nvidia|libnvidia|libva-nvidia|libva-utils|egl-wayland|egl-wayland2|ublue-os-nvidia|vulkan-loader|vulkan-tools)/i,
      )
        .split("\n")
        .sort()
        .join("\n"),
    );
});
const auditGraphicsAPIs = Effect.fn("desktopAudit.graphicsAPIs")(function* () {
  yield* section("graphics-apis");
  for (const [command, ...args] of [
    ["glxinfo", "-B"],
    ["eglinfo", "-B"],
    ["vainfo", "--display", "wayland"],
  ])
    yield* printIfAvailable(command ?? "", ...args);
  if (!(yield* printIfAvailable("vulkaninfo", "--summary")))
    yield* Console.log("vulkaninfo not available");
});
const auditFlatpakGL = Effect.fn("desktopAudit.flatpakGL")(function* () {
  yield* section("flatpak-gl");
  if (!(yield* available("flatpak"))) return;
  yield* printCommand(["flatpak", "--gl-drivers"]);
  for (const runtime of yield* flatpakRefs("runtimes"))
    if (/nvidia|org\.freedesktop\.Platform\.(GL|VAAPI)/i.test(runtime.id))
      yield* Console.log(Object.values(runtime).join("\t"));
});
const memoryPercent = Effect.fn("desktopAudit.memoryPercent")(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists("/proc/meminfo")) {
    const info = yield* fs.readFileString("/proc/meminfo");
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]);
    if (total > 0 && Number.isFinite(available)) return (1 - available / total) * 100;
  }
  return yield* Effect.sync(() => (1 - freemem() / totalmem()) * 100);
});
const auditPowerAndDesktop = Effect.fn("desktopAudit.powerAndDesktop")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* section("power");
  yield* printIfAvailable("powerprofilesctl", "get");
  for (const path of [
    "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
    "/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference",
  ])
    if (yield* fs.exists(path)) yield* Console.log(`${path}=${yield* readText(path)}`);
  yield* section("pressure");
  yield* printIfAvailable("uptime");
  yield* printIfAvailable("free", "-h");
  yield* printIfAvailable("systemd-inhibit", "--list", "--no-pager");
  yield* Console.log(
    `load=${JSON.stringify(yield* Effect.sync(loadavg))} memory_used=${(yield* memoryPercent()).toFixed(1)}%`,
  );
  yield* section("failed-units");
  if (yield* available("systemctl")) {
    yield* printCommand(["systemctl", "--failed", "--no-pager"]);
    yield* printCommand(["systemctl", "--user", "--failed", "--no-pager"]);
  }
  yield* section("gnome");
  yield* printIfAvailable("gsettings", "get", "org.gnome.shell", "enabled-extensions");
  yield* printIfAvailable("gnome-extensions", "list", "--enabled");
  if (yield* available("journalctl"))
    yield* Console.log(
      matchingLines(
        yield* output(
          ["journalctl", "--user", "-b", "--no-pager", "-p", "warning..alert"],
          { check: false },
        ),
        /gnome-shell|mutter|extension|clutter|st_widget|g_closure|gpu|egl|vulkan|wayland/i,
        80,
        true,
      ),
    );
});
const auditProcessesAndLogs = Effect.fn("desktopAudit.processesAndLogs")(function* () {
  yield* section("chromium");
  if (yield* available("ps"))
    yield* Console.log(
      matchingLines(
        yield* output(["ps", "-eo", "pid,ppid,pcpu,pmem,comm,args", "--sort=-pcpu"], {
          check: false,
        }),
        /helium|chrom|electron|discord/i,
        40,
      ),
    );
  yield* section("kernel-gpu");
  if (yield* available("journalctl"))
    yield* Console.log(
      matchingLines(
        yield* output(["journalctl", "-k", "-b", "--no-pager"], { check: false }),
        /nouveau|nvidia|amdgpu|i915|drm|gpu|xid|timeout|hang|stall|firmware/i,
        120,
        true,
      ),
    );
  yield* section("hot-processes");
  if (yield* available("ps"))
    yield* Console.log(
      (yield* output(
        ["ps", "-eo", "pid,ppid,ni,pri,psr,pcpu,pmem,comm,args", "--sort=-pcpu"],
        { check: false },
      ))
        .split("\n")
        .slice(0, 30)
        .join("\n"),
    );
});
export const desktopAudit = Effect.fn("desktopAudit")(function* () {
  for (const collect of [
    auditSystem,
    auditGraphics,
    auditGraphicsAPIs,
    auditFlatpakGL,
    auditPowerAndDesktop,
    auditProcessesAndLogs,
  ])
    yield* collect();
});
