#!/usr/bin/env python3
"""Prepare or run workstation automation with Python 3.9+ and the standard library."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from contextlib import suppress
from functools import partial
from pathlib import Path
from types import FrameType

# Keep these independent of the workstation package and its development lockfile
ANSIBLE_PACKAGE = "ansible==14.4.0"
ANSIBLE_PYTHON = "3.14"
MINIMUM_MACOS_MAJOR = 27
HOMEBREW_REVISION = "525cea89e317348cda72711932734eb30613b559"
HOMEBREW_URL = (
    f"https://raw.githubusercontent.com/Homebrew/install/{HOMEBREW_REVISION}/install.sh"
)
HOMEBREW_SHA256 = "71d25d14c32edd7adeaf4413ba671b28474ea08e4f6662cb1a73e85ff0eba368"
COLLECTIONS = ("ansible/posix", "community/general", "community/sops")
BECOME_OPTIONS = frozenset({
    "-K",
    "--ask-become-pass",
    "--become-password-file",
    "--become-pass-file",
})
READ_ONLY_OPTIONS = frozenset({
    "--syntax-check",
    "--list-tasks",
    "--list-tags",
    "--list-hosts",
    "--help",
    "-h",
    "--version",
})
GNU_PACKAGES = (
    "coreutils",
    "findutils",
    "gnu-sed",
    "grep",
    "gawk",
    "gnu-tar",
    "gnu-which",
    "diffutils",
    "make",
)
ROOT = Path(__file__).absolute().parent.resolve().parent


class SetupError(Exception):
    """An actionable setup failure."""


def log(message: str) -> None:
    print(f"\n==> {message}", flush=True)


def executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


class Workstation:
    def __init__(self) -> None:
        self.system = platform.system()
        self.nixos = self.system == "Linux" and Path("/etc/NIXOS").exists()
        self.user_bin = Path.home() / ".local/bin"
        self.runtime_bin = (
            Path("/run/current-system/sw/bin") if self.nixos else self.user_bin
        )
        self.brew_prefix = self.homebrew_prefix() if not self.nixos else None
        self.env = os.environ.copy()
        paths = [self.runtime_bin]
        if self.brew_prefix:
            if self.system == "Darwin":
                paths.extend(
                    self.brew_prefix / "opt" / package / "libexec/gnubin"
                    for package in GNU_PACKAGES
                )
                paths.append(self.brew_prefix / "opt/gnu-getopt/bin")
            paths.extend([self.brew_prefix / "bin", self.brew_prefix / "sbin"])
        self.env["PATH"] = os.pathsep.join(
            [str(path) for path in paths] + [self.env.get("PATH", os.defpath)]
        )
        self.env["UV_PYTHON_BIN_DIR"] = str(self.user_bin)
        self.env["UV_TOOL_BIN_DIR"] = str(self.user_bin)
        self.playbook = self.runtime_bin / "ansible-playbook"

    def homebrew_prefix(self) -> Path:
        if self.system == "Darwin":
            if platform.machine() != "arm64":
                raise SetupError("use a native Apple Silicon terminal, not Rosetta")
            return Path("/opt/homebrew")
        if self.system == "Linux":
            return Path("/home/linuxbrew/.linuxbrew")
        raise SetupError(f"unsupported platform: {self.system}")

    def command(
        self,
        *args: str | Path,
        env: dict[str, str] | None = None,
        stdout: int | None = None,
        stderr: int | None = None,
        stdin_text: str | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        return subprocess.run(
            args,
            cwd=ROOT,
            env=self.env if env is None else env,
            check=check,
            stdout=stdout,
            stderr=stderr,
            input=stdin_text,
            text=True,
        )

    def output(self, *args: str | Path) -> str:
        return self.command(*args, stdout=subprocess.PIPE).stdout.strip()

    def succeeds(self, *args: str | Path, stdin_text: str | None = None) -> bool:
        return (
            self.command(
                *args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin_text=stdin_text,
                check=False,
            ).returncode
            == 0
        )

    def sudo_password(self) -> str:
        if not shutil.which("sudo", path=self.env["PATH"]):
            raise SetupError("privileged tasks require sudo")
        validate = partial(self.succeeds, "sudo", "-S", "-k", "-p", "", "-v")
        # The local credential source is never printed or passed in argv
        try:
            password = Path("/etc/bleh").read_text(encoding="utf-8").rstrip("\n")
        except OSError:
            password = None
        if password is not None and validate(stdin_text=password + "\n"):
            return password
        if not sys.stdin.isatty():
            raise SetupError("sudo authentication is required; run interactively")
        for _ in range(3):
            password = getpass.getpass(f"[sudo] password for {getpass.getuser()}: ")
            if validate(stdin_text=password + "\n"):
                return password
            print("Sorry, try again.", file=sys.stderr)
        raise SetupError("failed to validate sudo credentials")

    def ensure_sudo(self) -> None:
        if not self.succeeds("sudo", "-n", "-v"):
            self.sudo_password()

    def ensure_homebrew(self) -> None:
        brew = self.brew_prefix / "bin/brew"
        if executable(brew):
            return
        self.ensure_sudo()
        if (
            self.system == "Linux"
            and Path("/usr/lib/systemd/system/brew-setup.service").is_file()
        ):
            log("Activating image-provisioned Homebrew")
            self.command("sudo", "systemctl", "start", "brew-setup.service")
        else:
            with tempfile.TemporaryDirectory(prefix="dotfiles-bootstrap.") as temp:
                installer = Path(temp) / "homebrew-install.sh"
                url = self.env.get("HOMEBREW_INSTALLER_URL", HOMEBREW_URL)
                checksum = self.env.get("HOMEBREW_INSTALLER_CHECKSUM", HOMEBREW_SHA256)
                checksum = checksum.removeprefix("sha256:").lower()
                if not re.fullmatch(r"[0-9a-f]{64}", checksum):
                    raise SetupError(
                        "Homebrew installer requires a valid SHA-256 checksum"
                    )
                log("Downloading the Homebrew installer")
                # Use the host's TLS trust store, including on Apple's Python
                if shutil.which("curl", path=self.env["PATH"]):
                    self.command(
                        "curl",
                        "-fsSL",
                        "--retry",
                        "3",
                        "--retry-delay",
                        "1",
                        "-o",
                        installer,
                        url,
                    )
                else:
                    self.command(
                        "wget",
                        "--quiet",
                        "--tries=3",
                        "--timeout=30",
                        f"--output-document={installer}",
                        url,
                    )
                if hashlib.sha256(installer.read_bytes()).hexdigest() != checksum:
                    raise SetupError("Homebrew installer checksum mismatch")
                log(f"Installing Homebrew into {self.brew_prefix}")
                self.command("bash", installer, env=dict(self.env, NONINTERACTIVE="1"))
        if not executable(brew):
            raise SetupError(f"Homebrew did not create {brew}")

    def missing_collections(self) -> list[str]:
        base = ROOT / ".ansible/collections/ansible_collections"
        return [
            name
            for name in COLLECTIONS
            if not (base / name / "MANIFEST.json").is_file()
        ]

    def require_runtime(self) -> None:
        if not executable(self.playbook):
            hint = (
                "rebuild NixOS, then run just bootstrap"
                if self.nixos
                else "run just bootstrap"
            )
            raise SetupError(f"Ansible is missing at {self.playbook}; {hint}")
        if not self.succeeds(self.playbook, "--version"):
            raise SetupError("the Ansible runtime is broken; run just bootstrap")
        missing = self.missing_collections()
        if missing:
            raise SetupError(
                f"missing Ansible collections: {', '.join(missing)}; run just bootstrap"
            )

    def bootstrap(self) -> None:
        requirements = ROOT / "ansible/requirements.yml"
        if not requirements.is_file():
            raise SetupError(f"missing collection requirements: {requirements}")
        if self.nixos:
            for name in ("ansible-galaxy", "ansible-playbook"):
                if not executable(self.runtime_bin / name):
                    raise SetupError(f"rebuild NixOS first: missing {name}")
        else:
            self.install_runtime()
        log("Installing Ansible collections")
        args = [
            "collection",
            "install",
            "--requirements-file",
            requirements,
            "--collections-path",
            ROOT / ".ansible/collections",
        ]
        # Repair directories left behind by interrupted collection installs
        if self.missing_collections():
            args.append("--force")
        self.command(self.runtime_bin / "ansible-galaxy", *args)
        self.require_runtime()
        log("Ansible dependencies are ready")

    def install_runtime(self) -> None:
        if self.system == "Darwin":
            version = self.output("sw_vers", "-productVersion")
            if int(version.split(".")[0]) < MINIMUM_MACOS_MAJOR:
                raise SetupError(
                    f"macOS {MINIMUM_MACOS_MAJOR}+ is required; found {version}"
                )
        self.ensure_homebrew()
        brew = self.brew_prefix / "bin/brew"
        if self.output(brew, "--prefix") != str(self.brew_prefix):
            raise SetupError("Homebrew reported an unexpected prefix")
        uv = self.brew_prefix / "bin/uv"
        if not executable(uv):
            self.command(
                brew,
                "install",
                "--formula",
                "uv",
                env=dict(self.env, HOMEBREW_NO_ASK="1"),
            )
        self.user_bin.mkdir(parents=True, exist_ok=True)
        log(f"Preparing Ansible's Python {ANSIBLE_PYTHON} runtime")
        self.command(uv, "--no-config", "python", "install", ANSIBLE_PYTHON)
        python = self.user_bin / f"python{ANSIBLE_PYTHON}"
        self.command(
            python,
            "-c",
            "import sys; expected = tuple(map(int, sys.argv[1].split('.'))); "
            "raise SystemExit(sys.version_info[:2] != expected)",
            ANSIBLE_PYTHON,
        )
        log(f"Preparing {ANSIBLE_PACKAGE}")
        self.command(
            uv,
            "--no-config",
            "tool",
            "install",
            "--python",
            python,
            "--no-python-downloads",
            "--with-executables-from",
            "ansible-core",
            ANSIBLE_PACKAGE,
        )
        if f"python version = {ANSIBLE_PYTHON}." not in self.output(
            self.playbook, "--version"
        ):
            raise SetupError(f"Ansible is not running on Python {ANSIBLE_PYTHON}")

    def run(self, args: list[str]) -> None:
        self.require_runtime()
        env = self.env.copy()
        option_names = {arg.partition("=")[0] for arg in args}
        explicit = bool(BECOME_OPTIONS & option_names) or bool(
            env.get("ANSIBLE_BECOME_PASSWORD_FILE")
        )
        password = env.get("ANSIBLE_BECOME_PASS") or env.get("ANSIBLE_BECOME_PASSWORD")
        infer_password = (
            not explicit
            and not password
            and not READ_ONLY_OPTIONS & option_names
            and sys.stdin.isatty()
            and not env.get("ANSIBLE_BECOME_ASK_PASS")
        )
        if infer_password and not self.succeeds("sudo", "-n", "-k", "-v"):
            password = self.sudo_password()
        if not explicit and not env.get("ANSIBLE_BECOME_ASK_PASS"):
            env["ANSIBLE_BECOME_ASK_PASS"] = "false"  # ruff: ignore[hardcoded-password-string]
        log("Running Ansible playbook: ansible/site.yml")
        with tempfile.TemporaryDirectory(prefix="dotfiles-ansible.") as temp:
            if password is not None and not explicit:
                # Only the helper code touches disk; the credential stays in memory
                helper = Path(temp) / "become-password"
                helper.write_text(
                    '#!/bin/sh\nprintf "%s\\n" "$ANSIBLE_BECOME_PASS"\n',
                    encoding="utf-8",
                )
                helper.chmod(0o700)
                env.update(
                    ANSIBLE_BECOME_PASS=password,
                    ANSIBLE_BECOME_ASK_PASS="false",  # ruff: ignore[hardcoded-password-func-arg]
                    ANSIBLE_BECOME_PASSWORD_FILE=str(helper),
                )
            self.command(self.playbook, "ansible/site.yml", *args, env=env)

    def private_settings_accessible(self, timeout: int) -> bool:
        env = dict(
            self.env,
            SOPS_AGE_KEY_CMD=str(
                ROOT / "dotfiles/dot_local/bin/executable_sops-age-key-1password"
            ),
        )
        # Bound the entire helper process tree while desktop approval is pending
        with subprocess.Popen(
            [
                str(self.brew_prefix / "bin/sops"),
                "decrypt",
                str(ROOT / "secrets/secrets.yaml"),
            ],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            start_new_session=True,
        ) as process:
            try:
                return process.wait(timeout=timeout) == 0
            except subprocess.TimeoutExpired:
                return False
            finally:
                # Clean up helpers on timeout, interruption, and parent exit
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()

    def ensure_private_settings(self) -> None:
        log("Checking access to private settings (1Password may request approval)")
        if self.private_settings_accessible(60 if sys.stdin.isatty() else 5):
            return
        if not sys.stdin.isatty():
            raise SetupError(
                "private settings unavailable; run setup interactively and sign in to 1Password"
            )
        self.succeeds("open", "-a", "1Password")
        print(
            "Sign in to and unlock 1Password, then enable:\n"
            "Settings > Developer > Integrate with 1Password CLI."
        )
        input("Press Return to continue: ")
        if not self.private_settings_accessible(60):
            raise SetupError("private settings are still unavailable from 1Password")

    def verify_setup_prerequisites(self) -> None:
        if not executable(self.brew_prefix / "bin/just"):
            raise SetupError("the userland stage did not install just")
        if self.system == "Darwin":
            self.ensure_private_settings()

    def apply_dotfiles(self) -> None:
        just = (self.runtime_bin if self.nixos else self.brew_prefix / "bin") / "just"
        log("Applying chezmoi dotfiles")
        self.command(just, "--justfile", ROOT / "Justfile", "apply")

    def setup(self) -> None:
        userland = (
            ()
            if self.nixos
            else (
                partial(self.run, ["--tags", "stage-10,stage-20"]),
                self.verify_setup_prerequisites,
                partial(self.run, ["--tags", "stage-30"]),
            )
        )
        steps = (
            self.bootstrap,
            *userland,
            self.apply_dotfiles,
            partial(self.run, ["--tags", "host"]),
        )
        for step in steps:
            step()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Workstation automation using Python 3.9+; no Python packages required",
        epilog="Use 'run --tags helium' for selected tasks; only bootstrap/setup install dependencies",
        allow_abbrev=False,
    )
    subcommands = parser.add_subparsers(required=True)
    commands = (
        (Workstation.bootstrap, "Prepare or repair Ansible dependencies", False),
        (
            Workstation.setup,
            "Install userland, apply dotfiles, and configure the host",
            False,
        ),
        (Workstation.run, "Pass arguments through to ansible-playbook", True),
    )
    for action, description, forward in commands:
        subparser = subcommands.add_parser(
            action.__name__,
            help=description,
            description=description,
            add_help=not forward,
            allow_abbrev=False,
        )
        subparser.set_defaults(action=action, forward=forward)
    options, args = parser.parse_known_args()
    if args and not options.forward:
        parser.error(
            f"unrecognized arguments: {' '.join(args)}; use run for Ansible options"
        )
    if args[:1] == ["--"]:
        args = args[1:]
    if sys.version_info < (3, 9):  # ruff: ignore[outdated-version-block]
        parser.error("Python 3.9 or newer is required")
    if os.geteuid() == 0:
        parser.error("do not run as root; privileged tasks use sudo")
    options.action(Workstation(), **({"args": args} if options.forward else {}))


def interrupted(_signum: int, _frame: FrameType | None) -> None:
    raise KeyboardInterrupt


if __name__ == "__main__":
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, interrupted)
    try:
        main()
    except (SetupError, OSError, EOFError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as error:
        print(
            f"error: {error.cmd[0]} exited with status {error.returncode}",
            file=sys.stderr,
        )
        sys.exit(error.returncode if error.returncode > 0 else 1)
    except KeyboardInterrupt:
        sys.exit(130)
