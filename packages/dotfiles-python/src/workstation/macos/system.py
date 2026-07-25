import os
import sys
import tempfile
import time
from pathlib import Path

from workstation.automation import automation_check_mode
from workstation.automation_models import OperationResult
from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.files import (
    ensure_directory,
    install_file_if_changed,
    require_executable,
    require_file,
)
from workstation.lib.http import download
from workstation.lib.paths import asset_path
from workstation.lib.retry import wait_until
from workstation.lib.sources import SOURCES
from workstation.lib.templates import render_template

KARABINER_SOURCE = SOURCES.require("karabiner_vhid")
KARABINER_VERSION = KARABINER_SOURCE.require_version()
KARABINER_PACKAGE = KARABINER_SOURCE.require_artifact("macos_package")
KARABINER_LABEL = "org.pqrs.service.daemon.Karabiner-VirtualHIDDevice-Daemon"
KANATA_LABEL = "dev.4evy.kanata"


def _require_root(command: str) -> None:
    if os.geteuid() != 0:
        raise DotfilesError(f"{command}: this command must run as root")


def _source_root() -> Path:
    return asset_path("macos")


def _chown_root(*paths: Path) -> None:
    run(("chown", "-R", "root:wheel", *paths))


def _bootout(plist: Path) -> None:
    run(("launchctl", "bootout", "system", plist), check=False, capture=True)


def _karabiner_paths() -> tuple[Path, Path, Path]:
    manager = Path(
        "/Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/"
        "Karabiner-VirtualHIDDevice-Manager"
    )
    daemon = Path(
        "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/"
        "Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/"
        "Karabiner-VirtualHIDDevice-Daemon"
    )
    plist = Path(f"/Library/LaunchDaemons/{KARABINER_LABEL}.plist")
    return manager, daemon, plist


def configure_karabiner_vhid() -> OperationResult:
    """Install and activate the pinned Karabiner VirtualHID DriverKit daemon."""
    _require_root("karabiner-vhid")
    require_commands("installer", "launchctl", "chown")
    manager, daemon, plist = _karabiner_paths()
    if automation_check_mode():
        running = (
            run(
                ("launchctl", "print", f"system/{KARABINER_LABEL}"),
                check=False,
                capture=True,
            ).returncode
            == 0
        )
        current = all(path.is_file() for path in (manager, daemon, plist)) and running
        return OperationResult(
            changed=not current,
            msg=(
                "Karabiner VirtualHID is current"
                if current
                else "Would install or activate Karabiner VirtualHID"
            ),
        )
    if not (manager.is_file() and os.access(manager, os.X_OK)) or not (
        daemon.is_file() and os.access(daemon, os.X_OK)
    ):
        package = f"Karabiner-DriverKit-VirtualHIDDevice-{KARABINER_VERSION}.pkg"
        with tempfile.TemporaryDirectory(prefix="karabiner-vhid-") as temporary:
            package_path = Path(temporary) / package
            download(
                KARABINER_PACKAGE.url,
                package_path,
                expected_sha256=KARABINER_PACKAGE.sha256,
            )
            run(("installer", "-pkg", package_path, "-target", "/"))
    require_executable(manager)
    require_executable(daemon)
    # The manager prints activation progress to stdout. Keep the automation
    # protocol's stdout reserved for its single JSON response.
    run((manager, "forceActivate"), output_mode="stderr")

    ensure_directory("/var/log/karabiner", "0755")
    _bootout(plist)
    render_template(
        _source_root() / "templates/karabiner-vhid.plist.in",
        plist,
        {"LABEL": KARABINER_LABEL, "DAEMON": daemon},
    )
    run(("chown", "root:wheel", plist))
    run(("launchctl", "bootstrap", "system", plist))
    run(("launchctl", "enable", f"system/{KARABINER_LABEL}"))
    run(("launchctl", "kickstart", "-k", f"system/{KARABINER_LABEL}"))
    return OperationResult(changed=True, msg="Activated Karabiner VirtualHID")


def _ensure_virtual_hid() -> None:
    state = run(
        ("launchctl", "print", f"system/{KARABINER_LABEL}"),
        check=False,
        capture=True,
    )
    if state.returncode != 0:
        configure_karabiner_vhid()
    else:
        run(
            ("launchctl", "kickstart", "-k", f"system/{KARABINER_LABEL}"),
            check=False,
            capture=True,
        )

    def daemon_running() -> bool:
        state = run(
            ("launchctl", "print", f"system/{KARABINER_LABEL}"),
            check=False,
            capture=True,
        )
        return "state = running" in state.stdout

    if not wait_until(daemon_running, attempts=20, interval=0.5):
        raise DotfilesError(f"kanata: {KARABINER_LABEL} did not reach running state")


def _ensure_signing_identity(identity: str, keychain: Path) -> bool:
    identities = run(
        ("security", "find-identity", "-v", "-p", "codesigning", keychain),
        check=False,
        capture=True,
    ).stdout
    if identity in identities:
        return True
    with tempfile.TemporaryDirectory(prefix="kanata-codesign-") as temporary:
        root = Path(temporary)
        openssl_config = root / "kanata-codesign-openssl.cnf"
        render_template(
            _source_root() / "templates/kanata-codesign-openssl.cnf.in",
            openssl_config,
            {"identity": identity},
        )
        key = root / "kanata.key"
        certificate = root / "kanata.crt"
        archive = root / "kanata.p12"
        run((
            "openssl",
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-x509",
            "-days",
            "3650",
            "-out",
            certificate,
            "-config",
            openssl_config,
        ))
        run((
            "openssl",
            "pkcs12",
            "-export",
            "-inkey",
            key,
            "-in",
            certificate,
            "-out",
            archive,
            "-passout",
            "pass:kanata-local",
        ))
        run((
            "security",
            "import",
            archive,
            "-k",
            keychain,
            "-P",
            "kanata-local",
            "-T",
            "/usr/bin/codesign",
        ))
        run((
            "security",
            "add-trusted-cert",
            "-d",
            "-r",
            "trustRoot",
            "-p",
            "codeSign",
            "-k",
            keychain,
            certificate,
        ))
    return (
        identity
        in run(
            ("security", "find-identity", "-v", "-p", "codesigning", keychain),
            check=False,
            capture=True,
        ).stdout
    )


def _stop_daemon(label: str) -> None:
    _bootout(Path(f"/Library/LaunchDaemons/{label}.plist"))


def configure_kanata(
    config: Path,
) -> OperationResult:
    """Install, sign, and launch Kanata with VirtualHID support.

    Parameters
    ----------
    config
        Kanata configuration file.

    """
    _require_root("kanata")
    config = require_file(config)
    require_commands("chown", "codesign", "launchctl", "openssl", "security")
    if automation_check_mode():
        return OperationResult(
            changed=True, msg="Would reconcile the macOS Kanata launch daemon"
        )
    source = _source_root()
    kanata_bin = require_executable("/opt/homebrew/bin/kanata")
    logitech = require_file(source / "logitech-platform.py")
    label = KANATA_LABEL
    app = Path("/Applications/Kanata.app")
    app_bin = app / "Contents/MacOS/kanata"
    info_plist = app / "Contents/Info.plist"
    identity = "Kanata Local Code Signing"
    keychain = Path("/Library/Keychains/System.keychain")

    _ensure_virtual_hid()
    ensure_directory(app_bin.parent, "0755")
    install_file_if_changed(kanata_bin, app_bin, "0755")
    render_template(
        source / "templates/kanata-app-info.plist.in",
        info_plist,
        {"BUNDLE_IDENTIFIER": label},
    )
    _chown_root(app)
    if _ensure_signing_identity(identity, keychain):
        run((
            "codesign",
            "--force",
            "--keychain",
            keychain,
            "--sign",
            identity,
            app,
        ))
    else:
        run(("codesign", "--force", "--sign", "-", app))
    run((
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        "-f",
        app,
    ))
    _stop_daemon(label)
    time.sleep(0.5)
    result = run(
        (
            sys.executable,
            logitech,
            "--product-id",
            "0xB377",
            "--product-name",
            "Pebble K380s",
            "--platform",
            "0",
        ),
        check=False,
    )
    if result.returncode != 0:
        error_console.print(
            "kanata: warning: failed to configure Pebble K380s non-macOS mode; "
            "continuing with Kanata setup"
        )

    plist = Path(f"/Library/LaunchDaemons/{label}.plist")
    _stop_daemon(label)
    render_template(
        source / "templates/kanata-daemon.plist.in",
        plist,
        {
            "LABEL": label,
            "APP_BIN": app_bin,
            "CONFIG_PATH": config,
            "LOG_PATH": "/var/log/kanata.log",
        },
    )
    run(("chown", "root:wheel", plist))
    run(("launchctl", "bootstrap", "system", plist))
    run(("launchctl", "enable", f"system/{label}"))
    run(("launchctl", "kickstart", "-k", f"system/{label}"))
    time.sleep(3)
    state = run(
        ("launchctl", "print", f"system/{label}"),
        check=False,
        capture=True,
    )
    if state.returncode != 0 or "state = running" not in state.stdout:
        raise DotfilesError(
            "kanata: daemon exited during startup; grant Input Monitoring and "
            "Accessibility to /Applications/Kanata.app in System Settings, then "
            "rerun setup"
        )
    return OperationResult(
        changed=True, msg="Reconciled the macOS Kanata launch daemon"
    )
