import { existsSync, readFileSync } from "node:fs";
import { freemem, loadavg, release, totalmem } from "node:os";
import { output, run } from "../../../../lib/typescript/commands.ts";
import { flatpakRefs } from "../linux/desktop.ts";

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}
function printCommand(args: string[]): string {
  const result = run(args, { check: false, capture: true });
  if (result.stdout) console.log(result.stdout.trimEnd());
  return result.stdout;
}
function printIfAvailable(command: string, ...args: string[]): boolean {
  if (!Bun.which(command)) return false;
  printCommand([command, ...args]);
  return true;
}
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
function auditSystem(): void {
  section("system");
  printIfAvailable("hostnamectl");
  console.log(
    `session=${process.env.XDG_SESSION_TYPE ?? "unknown"} desktop=${process.env.XDG_CURRENT_DESKTOP ?? "unknown"}`,
  );
  console.log(`kernel=${release()}`);
  for (const command of ["rpm-ostree", "bootc"]) printIfAvailable(command, "status");
}
function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}
function auditGraphics(): void {
  section("graphics");
  printIfAvailable("lspci", "-nnk", "-d", "::03xx");
  if (existsSync("/dev/dri")) printIfAvailable("ls", "-l", "/dev/dri");
  if (Bun.which("lsmod"))
    console.log(
      matchingLines(
        output(["lsmod"], { check: false }),
        /^(nvidia|nouveau|amdgpu|i915)/i,
      ),
    );
  if (existsSync("/sys/class/drm"))
    for (const device of new Bun.Glob("card[0-9]/device").scanSync({
      cwd: "/sys/class/drm",
      absolute: true,
    }))
      console.log(
        `${device} vendor=${readText(`${device}/vendor`)} device=${readText(`${device}/device`)}`,
      );
  printIfAvailable("nvidia-smi");
  if (Bun.which("rpm"))
    console.log(
      matchingLines(
        output(["rpm", "-qa"], { check: false }),
        /^(nvidia|kmod-nvidia|akmod-nvidia|xorg-x11-nvidia|libnvidia|libva-nvidia|libva-utils|egl-wayland|egl-wayland2|ublue-os-nvidia|vulkan-loader|vulkan-tools)/i,
      )
        .split("\n")
        .sort()
        .join("\n"),
    );
}
function auditGraphicsAPIs(): void {
  section("graphics-apis");
  for (const [command, ...args] of [
    ["glxinfo", "-B"],
    ["eglinfo", "-B"],
    ["vainfo", "--display", "wayland"],
  ])
    printIfAvailable(command ?? "", ...args);
  if (!printIfAvailable("vulkaninfo", "--summary"))
    console.log("vulkaninfo not available");
}
function auditFlatpakGL(): void {
  section("flatpak-gl");
  if (!Bun.which("flatpak")) return;
  printCommand(["flatpak", "--gl-drivers"]);
  for (const runtime of flatpakRefs("runtimes"))
    if (/nvidia|org\.freedesktop\.Platform\.(GL|VAAPI)/i.test(runtime.id))
      console.log(Object.values(runtime).join("\t"));
}
function memoryPercent(): number {
  if (existsSync("/proc/meminfo")) {
    const info = readFileSync("/proc/meminfo", "utf8");
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]);
    if (total > 0 && Number.isFinite(available)) return (1 - available / total) * 100;
  }
  return (1 - freemem() / totalmem()) * 100;
}
function auditPowerAndDesktop(): void {
  section("power");
  printIfAvailable("powerprofilesctl", "get");
  for (const path of [
    "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
    "/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference",
  ])
    if (existsSync(path)) console.log(`${path}=${readText(path)}`);
  section("pressure");
  printIfAvailable("uptime");
  printIfAvailable("free", "-h");
  printIfAvailable("systemd-inhibit", "--list", "--no-pager");
  console.log(
    `load=${JSON.stringify(loadavg())} memory_used=${memoryPercent().toFixed(1)}%`,
  );
  section("failed-units");
  if (Bun.which("systemctl")) {
    printCommand(["systemctl", "--failed", "--no-pager"]);
    printCommand(["systemctl", "--user", "--failed", "--no-pager"]);
  }
  section("gnome");
  printIfAvailable("gsettings", "get", "org.gnome.shell", "enabled-extensions");
  printIfAvailable("gnome-extensions", "list", "--enabled");
  if (Bun.which("journalctl"))
    console.log(
      matchingLines(
        output(["journalctl", "--user", "-b", "--no-pager", "-p", "warning..alert"], {
          check: false,
        }),
        /gnome-shell|mutter|extension|clutter|st_widget|g_closure|gpu|egl|vulkan|wayland/i,
        80,
        true,
      ),
    );
}
function auditProcessesAndLogs(): void {
  section("chromium");
  if (Bun.which("ps"))
    console.log(
      matchingLines(
        output(["ps", "-eo", "pid,ppid,pcpu,pmem,comm,args", "--sort=-pcpu"], {
          check: false,
        }),
        /helium|chrom|electron|discord/i,
        40,
      ),
    );
  section("kernel-gpu");
  if (Bun.which("journalctl"))
    console.log(
      matchingLines(
        output(["journalctl", "-k", "-b", "--no-pager"], { check: false }),
        /nouveau|nvidia|amdgpu|i915|drm|gpu|xid|timeout|hang|stall|firmware/i,
        120,
        true,
      ),
    );
  section("hot-processes");
  if (Bun.which("ps"))
    console.log(
      output(["ps", "-eo", "pid,ppid,ni,pri,psr,pcpu,pmem,comm,args", "--sort=-pcpu"], {
        check: false,
      })
        .split("\n")
        .slice(0, 30)
        .join("\n"),
    );
}
export function desktopAudit(): void {
  for (const collect of [
    auditSystem,
    auditGraphics,
    auditGraphicsAPIs,
    auditFlatpakGL,
    auditPowerAndDesktop,
    auditProcessesAndLogs,
  ])
    collect();
}
