import datetime as dt
import os
import platform
import re
import subprocess
import sys
from pathlib import Path
from typing import Annotated, Literal

import psutil
from cyclopts import App, Group, Parameter, validators
from pydantic import TypeAdapter

from workstation.console import console, error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import output, run, which
from workstation.lib.files import write_if_changed
from workstation.lib.host import gsettings_available, user_config_home
from workstation.lib.paths import find_repo_root


def _exec(
    path: Path | str,
    arguments: list[str],
    environment: dict[str, str] | None = None,
) -> None:
    executable = os.fspath(path)
    os.execvpe(executable, (executable, *arguments), environment or os.environ)


_ALT_TAB_SERVICE = "com.lwouis.alt-tab-macos.license"
_ALT_TAB_VALUES = {
    "licenseKey": "0000-0000-0000-0000-0000-0000",
    "instanceId": "evy-instance-0",
    "variantId": "pro_lifetime",
}
_ALT_TAB_DEFAULT_KEYS = ("lastValidation", "lastValidationResult", "customerEmail")


def _install_alt_tab_license() -> None:
    for account, value in _ALT_TAB_VALUES.items():
        run(
            (
                "security",
                "add-generic-password",
                "-A",
                "-U",
                "-s",
                _ALT_TAB_SERVICE,
                "-a",
                account,
                "-w",
                value,
            ),
            capture=True,
        )
    defaults = (
        ("lastValidation", "float", str(int(dt.datetime.now(dt.UTC).timestamp()))),
        ("lastValidationResult", "bool", "true"),
        ("customerEmail", "string", "alt@evy.pink"),
    )
    for key, kind, value in defaults:
        run(("defaults", "write", _ALT_TAB_SERVICE, key, f"-{kind}", value))
    error_console.print("alt-tab-license: license installed; restart AltTab to apply")


def _remove_alt_tab_license() -> None:
    for account in _ALT_TAB_VALUES:
        run(
            (
                "security",
                "delete-generic-password",
                "-s",
                _ALT_TAB_SERVICE,
                "-a",
                account,
            ),
            check=False,
            capture=True,
        )
    for key in _ALT_TAB_DEFAULT_KEYS:
        run(("defaults", "delete", _ALT_TAB_SERVICE, key), check=False, capture=True)
    error_console.print(
        "alt-tab-license: license removed; restart AltTab to revert to trial"
    )


def _show_alt_tab_license() -> None:
    console.print("keychain items:")
    for account in _ALT_TAB_VALUES:
        value = (
            output(
                (
                    "security",
                    "find-generic-password",
                    "-s",
                    _ALT_TAB_SERVICE,
                    "-a",
                    account,
                    "-w",
                ),
                check=False,
            )
            or "none"
        )
        console.print(f"  {account + ':':<12} {value}")
    console.print(f"\ndefaults ({_ALT_TAB_SERVICE}):")
    for key in _ALT_TAB_DEFAULT_KEYS:
        value = (
            output(("defaults", "read", _ALT_TAB_SERVICE, key), check=False) or "none"
        )
        console.print(f"  {key + ':':<22} {value}")


def alt_tab_license(action: Literal["install", "remove", "status"]) -> None:
    """Install, remove, or display the AltTab license state."""
    actions = {
        "install": _install_alt_tab_license,
        "remove": _remove_alt_tab_license,
        "status": _show_alt_tab_license,
    }
    actions[action]()


_alt_tab_license_app = App(
    default_command=alt_tab_license,
    version_flags=[],
    result_action="return_none",
)


def alt_tab_license_entrypoint() -> None:
    _alt_tab_license_app()


def _shottr_license_key() -> str:
    repository = find_repo_root(Path.cwd())
    secrets = repository / "secrets/secrets.yaml"
    key = output((
        "sops",
        "--decrypt",
        "--extract",
        '["shottr-license-key"]',
        os.fspath(secrets),
    )).strip()
    if not re.fullmatch(r"[A-Z0-9]{6}(?:-[A-Z0-9]{6}){4}", key):
        raise DotfilesError("Shottr license key in SOPS has an unexpected format")
    return key


def _applescript_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _activate_shottr_license(key: str) -> None:
    script = f"""
set licenseCode to {_applescript_string(key)}

open location "shottr://settings/license"
delay 0.5

tell application "System Events"
  repeat 150 times
    if exists process "Shottr" then exit repeat
    delay 0.1
  end repeat

  tell process "Shottr"
    set frontmost to true
    repeat 150 times
      if exists window "Preferences" then exit repeat
      delay 0.1
    end repeat
    if not (exists window "Preferences") then error "Shottr preferences window did not appear"

    tell window "Preferences"
      if exists button "License" of toolbar 1 then click button "License" of toolbar 1
      delay 0.2

      if exists button "Change" of group 1 then
        click button "Change" of group 1
        delay 0.2
      end if

      set value of text field 1 of group 1 to licenseCode
      delay 0.2

      if exists button "Activate" of group 1 then
        click button "Activate" of group 1
      else
        error "Shottr activation button was not found"
      end if
    end tell
  end tell
end tell
"""
    result = subprocess.run(
        ("/usr/bin/osascript", "-"),
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip()
        message = "Shottr activation UI automation failed"
        if "not allowed assistive access" in details or "-25211" in details:
            message = (
                f"{message}: macOS denied Accessibility access to osascript. "
                "Grant Accessibility to the terminal running provisioning in "
                "System Settings > Privacy & Security > Accessibility, then rerun "
                "`dotfiles-scripts chezmoi shottr-license install --force`."
            )
        if details:
            message = f"{message}\n{details}"
        raise DotfilesError(message)


def _shottr_is_activated(domain: str) -> bool:
    stored_license = output(
        ("defaults", "read", domain, "kc-license"),
        check=False,
    ).strip()
    vault = output(
        ("defaults", "read", domain, "kc-vault"),
        check=False,
    ).strip()
    return bool(stored_license and vault)


def shottr_license(
    action: Literal["install", "status"], *, force: bool = False
) -> None:
    """Install or display the Shottr license state."""
    domain = "cc.ffitch.shottr"
    if action == "install":
        if _shottr_is_activated(domain) and not force:
            error_console.print(
                "shottr-license: Shottr already has activation state; leaving it in place"
            )
            return
        key = _shottr_license_key()
        _activate_shottr_license(key)
        error_console.print(
            "shottr-license: submitted license key through Shottr activation UI"
        )
        return
    if action == "status":
        if _shottr_is_activated(domain):
            console.print("shottr-license: installed")
        else:
            console.print("shottr-license: not installed")


def _real_codex(home: Path, wrapper: Path) -> Path:
    candidates = (
        os.environ.get("CODEX_REAL_BIN"),
        home / ".bun/bin/codex",
        home / ".cache/.bun/bin/codex",
        home / ".npm/bin/codex",
        home / ".bun/install/global/node_modules/.bin/codex",
        Path("/opt/homebrew/bin/codex"),
        Path("/usr/local/bin/codex"),
        Path("/usr/bin/codex"),
    )
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path != wrapper and path.is_file() and os.access(path, os.X_OK):
            return path
    raise DotfilesError("codex: real Codex binary not found")


def codex_entrypoint() -> None:
    home = Path.home()
    wrapper = Path(sys.argv[0]).resolve()
    real = _real_codex(home, wrapper)
    arguments = list(sys.argv[1:])
    themed_arguments = arguments.copy()
    if not os.environ.get("TERMINAL_THEME_RUN_CODEX_BIN"):
        themed_arguments = [
            value
            for value in themed_arguments
            if value != "--dangerously-bypass-approvals-and-sandbox"
        ]
    theme_runner = home / ".local/bin/terminal-theme-run"
    if not (theme_runner.is_file() and os.access(theme_runner, os.X_OK)):
        theme_runner = which("terminal-theme-run") or theme_runner
    if theme_runner.is_file() and os.access(theme_runner, os.X_OK):
        environment = dict(os.environ)
        environment["TERMINAL_THEME_RUN_CODEX_BIN"] = os.fspath(real)
        environment["TERMINAL_THEME_RUN_CODEX_WRAPPER"] = os.fspath(wrapper)
        _exec(theme_runner, ["codex", *themed_arguments], environment)
    _exec(real, arguments)


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
    for command, arguments in (
        ("glxinfo", ("-B",)),
        ("eglinfo", ("-B",)),
        ("vainfo", ("--display", "wayland")),
    ):
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
    for command, arguments in (("uptime", ()), ("free", ("-h",))):
        _print_if_available(command, *arguments)
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


def desktop_perf_audit_entrypoint() -> None:
    _audit_system()
    _audit_graphics()
    _audit_graphics_apis()
    _audit_flatpak_gl()
    _audit_power_and_desktop()
    _audit_processes_and_logs()


def _accent_colors() -> tuple[str, str]:
    repository = find_repo_root(Path(__file__))
    palette = TypeAdapter(dict[str, dict[str, str]]).validate_json(
        (repository / "dotfiles/.chezmoitemplates/catppuccin_palette.json").read_text()
    )
    return palette["latte"]["pink"], palette["frappe"]["pink"]


def _gnome_accent_apply() -> None:
    latte, frappe = _accent_colors()
    scheme = (
        output(
            ("gsettings", "get", "org.gnome.desktop.interface", "color-scheme"),
            check=False,
        )
        if gsettings_available()
        else "default"
    )
    accent = frappe if "prefer-dark" in scheme else latte
    gtk3 = f"""/* Generated by gnome-catppuccin-accent. */
@define-color accent_color {accent};
@define-color accent_bg_color {accent};
@define-color accent_fg_color rgba(0, 0, 0, 0.8);
@define-color theme_selected_bg_color {accent};
@define-color theme_selected_fg_color rgba(0, 0, 0, 0.8);
@define-color theme_unfocused_selected_bg_color {accent};
@define-color theme_unfocused_selected_fg_color rgba(0, 0, 0, 0.8);
"""
    gtk4 = f"""/* Generated by gnome-catppuccin-accent. */
@define-color accent_color {accent};
@define-color accent_bg_color {accent};
@define-color accent_fg_color rgba(0, 0, 0, 0.8);

:root {{
  --accent-bg-color: {accent};
  --accent-fg-color: rgb(0 0 0 / 80%);
  --accent-color: oklab(from var(--accent-bg-color) var(--standalone-color-oklab));
}}
"""
    config = user_config_home()
    write_if_changed(config / "gtk-3.0/catppuccin-accent.css", gtk3)
    write_if_changed(config / "gtk-4.0/catppuccin-accent.css", gtk4)
    if gsettings_available():
        valid = output(
            ("gsettings", "range", "org.gnome.desktop.interface", "accent-color"),
            check=False,
        )
        if "'pink'" in valid:
            run(
                (
                    "gsettings",
                    "set",
                    "org.gnome.desktop.interface",
                    "accent-color",
                    "pink",
                ),
                check=False,
                capture=True,
            )


_GNOME_ACCENT_MODE = Group("Mode", validator=validators.LimitedChoice(max=1))


def gnome_catppuccin_accent(
    *,
    once: Annotated[
        bool,
        Parameter(group=_GNOME_ACCENT_MODE, negative=""),
    ] = False,
    watch: Annotated[
        bool,
        Parameter(group=_GNOME_ACCENT_MODE, negative=""),
    ] = False,
) -> None:
    """Apply the GNOME accent once or watch for color-scheme changes."""
    del once
    _gnome_accent_apply()
    executable = which("gsettings")
    if watch and executable is not None:
        process = subprocess.Popen(
            (
                executable,
                "monitor",
                "org.gnome.desktop.interface",
                "color-scheme",
            ),
            stdout=subprocess.PIPE,
            text=True,
        )
        if process.stdout:
            for _line in process.stdout:
                _gnome_accent_apply()
        raise SystemExit(process.wait())


_gnome_accent_app = App(
    default_command=gnome_catppuccin_accent,
    version_flags=[],
    result_action="return_none",
)


def gnome_catppuccin_accent_entrypoint() -> None:
    _gnome_accent_app()


def python_entrypoint() -> None:
    environment = dict(os.environ)
    environment.setdefault("UV_PYTHON_PREFERENCE", "only-managed")
    _exec("uv", ["run", "python", *sys.argv[1:]], environment)


def python3_entrypoint() -> None:
    environment = dict(os.environ)
    environment.setdefault("UV_PYTHON_PREFERENCE", "only-managed")
    _exec("uv", ["run", "python3", *sys.argv[1:]], environment)


def vscode_nixd_entrypoint() -> None:
    _exec(os.environ.get("VSCODE_NIXD_PATH", "nixd"), sys.argv[1:])


def vscode_nixfmt_entrypoint() -> None:
    _exec(os.environ.get("VSCODE_NIXFMT_PATH", "nixfmt"), sys.argv[1:] or ["-"])
