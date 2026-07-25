"""Desktop performance diagnostics."""

import os
import platform
import re
from collections.abc import Callable
from pathlib import Path

import psutil

from workstation.console import console
from workstation.lib.commands import output, run, which
from workstation.lib.host import gsettings_available

AuditCollector = Callable[[], None]


def _section(name: str) -> None:
    console.print(f"\n== {name} ==")


def _print_command(*arguments: str) -> str:
    result = run(arguments, check=False, capture=True)
    if result.stdout:
        console.print(result.stdout.rstrip())
    return result.stdout


def _print_if_available(command: str, *arguments: str) -> bool:
    if which(command) is None:
        return False
    _print_command(command, *arguments)
    return True


def _matching_lines(
    text: str,
    pattern: str,
    *,
    limit: int | None = None,
    tail: bool = False,
) -> str:
    expression = re.compile(pattern, re.IGNORECASE)
    lines = [line for line in text.splitlines() if expression.search(line)]
    if limit is not None:
        lines = lines[-limit:] if tail else lines[:limit]
    return "\n".join(lines)


def _lspci_display_devices(text: str) -> str:
    lines = text.splitlines()
    selected: list[str] = []
    for index, line in enumerate(lines):
        if re.search(r"VGA|3D|Display", line, re.IGNORECASE):
            selected.extend(lines[index : index + 5])
    return "\n".join(dict.fromkeys(selected))


def _audit_system() -> None:
    _section("system")
    _print_if_available("hostnamectl")
    console.print(
        f"session={os.environ.get('XDG_SESSION_TYPE', 'unknown')} "
        f"desktop={os.environ.get('XDG_CURRENT_DESKTOP', 'unknown')}"
    )
    console.print(f"kernel={platform.release()}")
    for command in ("rpm-ostree", "bootc"):
        _print_if_available(command, "status")


def _audit_graphics() -> None:
    _section("graphics")
    if which("lspci"):
        console.print(_lspci_display_devices(output(("lspci", "-nnk"), check=False)))
    if Path("/dev/dri").exists() and which("ls"):
        _print_command("ls", "-l", "/dev/dri")
    if which("lsmod"):
        console.print(
            _matching_lines(
                output(("lsmod",), check=False),
                r"^(nvidia|nouveau|amdgpu|i915)",
            )
        )
    for device in Path("/sys/class/drm").glob("card[0-9]/device"):
        vendor_path = device / "vendor"
        device_path = device / "device"
        vendor = vendor_path.read_text().strip() if vendor_path.is_file() else ""
        identifier = device_path.read_text().strip() if device_path.is_file() else ""
        console.print(f"{device} vendor={vendor} device={identifier}")
    _print_if_available("nvidia-smi")
    if which("rpm"):
        packages = _matching_lines(
            output(("rpm", "-qa"), check=False),
            r"^(nvidia|kmod-nvidia|akmod-nvidia|xorg-x11-nvidia|libnvidia|"
            r"libva-nvidia|libva-utils|egl-wayland|egl-wayland2|"
            r"ublue-os-nvidia|vulkan-loader|vulkan-tools)",
        )
        console.print("\n".join(sorted(packages.splitlines())))


def _audit_graphics_apis() -> None:
    _section("graphics-apis")
    commands = (
        ("glxinfo", "-B"),
        ("eglinfo", "-B"),
        ("vainfo", "--display", "wayland"),
    )
    for command, *arguments in commands:
        _print_if_available(command, *arguments)
    if not _print_if_available("vulkaninfo", "--summary"):
        console.print("vulkaninfo not available")


def _audit_flatpak_gl() -> None:
    _section("flatpak-gl")
    if which("flatpak"):
        _print_command("flatpak", "--gl-drivers")
        runtimes = output(
            (
                "flatpak",
                "list",
                "--runtime",
                "--columns=application,branch,arch,origin,installation",
            ),
            check=False,
        )
        pattern = re.compile(
            r"nvidia|org\.freedesktop\.Platform\.(GL|VAAPI)", re.IGNORECASE
        )
        console.print(
            "\n".join(line for line in runtimes.splitlines() if pattern.search(line))
        )


def _audit_power_and_desktop() -> None:
    _section("power")
    _print_if_available("powerprofilesctl", "get")
    for path in (
        Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
        Path("/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference"),
    ):
        if path.is_file():
            console.print(f"{path}={path.read_text().strip()}")

    _section("pressure")
    for command in (("uptime",), ("free", "-h")):
        _print_if_available(*command)
    _print_if_available("systemd-inhibit", "--list", "--no-pager")
    memory = psutil.virtual_memory()
    console.print(f"load={os.getloadavg()} memory_used={memory.percent:.1f}%")

    _section("failed-units")
    if which("systemctl"):
        _print_command("systemctl", "--failed", "--no-pager")
        _print_command("systemctl", "--user", "--failed", "--no-pager")

    _section("gnome")
    if gsettings_available():
        _print_command("gsettings", "get", "org.gnome.shell", "enabled-extensions")
    _print_if_available("gnome-extensions", "list", "--enabled")
    if which("journalctl"):
        journal = output(
            ("journalctl", "--user", "-b", "--no-pager", "-p", "warning..alert"),
            check=False,
        )
        console.print(
            _matching_lines(
                journal,
                r"gnome-shell|mutter|extension|clutter|st_widget|g_closure|"
                r"gpu|egl|vulkan|wayland",
                limit=80,
                tail=True,
            )
        )


def _audit_processes_and_logs() -> None:
    _section("chromium")
    if which("ps"):
        process_table = output(
            ("ps", "-eo", "pid,ppid,pcpu,pmem,comm,args", "--sort=-pcpu"),
            check=False,
        )
        console.print(
            _matching_lines(
                process_table,
                r"helium|chrom|electron|discord",
                limit=40,
            )
        )

    _section("kernel-gpu")
    if which("journalctl"):
        kernel_log = output(("journalctl", "-k", "-b", "--no-pager"), check=False)
        console.print(
            _matching_lines(
                kernel_log,
                r"nouveau|nvidia|amdgpu|i915|drm|gpu|xid|timeout|hang|stall|firmware",
                limit=120,
                tail=True,
            )
        )

    _section("hot-processes")
    if which("ps"):
        table = output(
            (
                "ps",
                "-eo",
                "pid,ppid,ni,pri,psr,pcpu,pmem,comm,args",
                "--sort=-pcpu",
            ),
            check=False,
        )
        console.print("\n".join(table.splitlines()[:30]))


AUDIT_COLLECTORS: tuple[AuditCollector, ...] = (
    _audit_system,
    _audit_graphics,
    _audit_graphics_apis,
    _audit_flatpak_gl,
    _audit_power_and_desktop,
    _audit_processes_and_logs,
)


def desktop_perf_audit_entrypoint() -> None:
    for collect in AUDIT_COLLECTORS:
        collect()
