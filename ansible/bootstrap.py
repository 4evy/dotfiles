#!/usr/bin/env python3
# /// script
# requires-python = "==3.9.*"
# dependencies = []
# ///
"""Prepare or run workstation automation with the Python 3.9 standard library."""

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
from collections.abc import Callable, Iterable
from contextlib import ExitStack, suppress
from dataclasses import dataclass
from functools import partial
from itertools import dropwhile
from pathlib import Path
from threading import Event, Thread
from types import FrameType

# Keep these independent of the workstation package and its development lockfile
ANSIBLE_PACKAGE = "ansible==14.4.0"
ANSIBLE_PYTHON = "3.14"
MINIMUM_MACOS_MAJOR = 27
HOMEBREW_REVISION = "0a396a4ee5b538f409de666af904fa0570b53949"
HOMEBREW_URL = (
    f"https://raw.githubusercontent.com/Homebrew/install/{HOMEBREW_REVISION}/install.sh"
)
HOMEBREW_SHA256 = "f31a38f097f3b5bbfdc110658e4a9876d0c023ccc9ef2e70527f5b8a762e505e"
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
    def __init__(self, resources: ExitStack) -> None:
        self.resources = resources
        self.sudo_ready = False
        self.system = platform.system()
        self.nixos = self.system == "Linux" and Path("/etc/NIXOS").exists()
        self.user_bin = Path.home() / ".local/bin"
        self.runtime_bin = (
            Path("/run/current-system/sw/bin") if self.nixos else self.user_bin
        )
        self.brew_prefix = self.homebrew_prefix()
        self.env = os.environ.copy()
        paths = [self.runtime_bin]
        if not self.nixos:
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
        password = (
            self.env.get("DOTFILES_SUDO_PASSWORD")
            or self.env.get("ANSIBLE_BECOME_PASS")
            or self.env.get("ANSIBLE_BECOME_PASSWORD")
        )
        if password is not None and validate(stdin_text=password + "\n"):
            return password
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
        if self.sudo_ready:
            return
        # Ignore cached timestamps so a long run does not outlive its credential
        if not self.succeeds("sudo", "-n", "-k", "-v"):
            password = self.sudo_password()
            temp = self.resources.enter_context(
                tempfile.TemporaryDirectory(prefix="dotfiles-sudo.")
            )
            helper = Path(temp) / "askpass"
            helper.write_text(
                '#!/bin/sh\nprintf "%s\\n" "${DOTFILES_SUDO_PASSWORD:?}"\n',
                encoding="utf-8",
            )
            helper.chmod(0o700)
            sudo = self.env.get("DOTFILES_REAL_SUDO") or shutil.which(
                "sudo", path=self.env["PATH"]
            )
            if sudo is None:
                raise SetupError("privileged tasks require sudo")
            wrapper = Path(temp) / "sudo"
            wrapper.write_text(
                "#!/bin/sh\n"
                '"$DOTFILES_REAL_SUDO" -A -v || exit "$?"\n'
                '"$DOTFILES_REAL_SUDO" "$@"\n'
                'exit "$?"\n',
                encoding="utf-8",
            )
            wrapper.chmod(0o700)
            # Keep the wrapper alive so both sudo calls share its parent-PID ticket
            previous_env = self.env
            self.env = dict(
                self.env,
                DOTFILES_SUDO_PASSWORD=password,
                DOTFILES_REAL_SUDO=sudo,
                SUDO_ASKPASS=str(helper),
                PATH=os.pathsep.join((temp, self.env["PATH"])),
            )
            self.resources.callback(setattr, self, "env", previous_env)
            self.command(sudo, "-A", "-v", stdout=subprocess.DEVNULL)
            stop = Event()
            worker = Thread(
                target=refresh_sudo, args=(self.env.copy(), stop), daemon=True
            )
            worker.start()
            self.resources.callback(worker.join)
            self.resources.callback(stop.set)
        self.sudo_ready = True

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

    def install_collections(self) -> None:
        requirements = ROOT / "ansible/requirements.yml"
        if not requirements.is_file():
            raise SetupError(f"missing collection requirements: {requirements}")
        for name in ("ansible-galaxy", "ansible-playbook"):
            if not executable(self.runtime_bin / name):
                hint = "rebuild NixOS first" if self.nixos else "run bootstrap first"
                raise SetupError(f"missing {name}; {hint}")
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

    def prepare_homebrew(self) -> None:
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

    def install_uv(self) -> None:
        brew = self.brew_prefix / "bin/brew"
        uv = self.brew_prefix / "bin/uv"
        if not executable(uv):
            self.command(
                brew,
                "install",
                "--formula",
                "uv",
                env=dict(self.env, HOMEBREW_NO_ASK="1"),
            )

    def install_python(self) -> None:
        uv = self.brew_prefix / "bin/uv"
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

    def install_ansible(self) -> None:
        uv = self.brew_prefix / "bin/uv"
        python = self.user_bin / f"python{ANSIBLE_PYTHON}"
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
        password = env.get("ANSIBLE_BECOME_PASS") or env.get("ANSIBLE_BECOME_PASSWORD")
        if password:
            env["ANSIBLE_BECOME_PASS"] = password
        option_names = {arg.partition("=")[0] for arg in args}
        explicit = bool(password or BECOME_OPTIONS & option_names) or bool(
            env.get("ANSIBLE_BECOME_PASSWORD_FILE")
        )
        ask_pass = env.get("ANSIBLE_BECOME_ASK_PASS", "").strip().lower() in {
            "1",
            "yes",
            "true",
            "on",
            "y",
            "t",
        }
        if not explicit and not ask_pass and not READ_ONLY_OPTIONS & option_names:
            self.ensure_sudo()
            env = self.env.copy()
            if password := env.get("DOTFILES_SUDO_PASSWORD"):
                env["ANSIBLE_BECOME_PASS"] = password
        if not explicit and not ask_pass:
            env["ANSIBLE_BECOME_ASK_PASS"] = "false"  # ruff: ignore[hardcoded-password-string]
        log("Running Ansible playbook: ansible/site.yml")
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

    def install_applications(self) -> None:
        if not executable(self.brew_prefix / "bin/just"):
            raise SetupError("the userland stage did not install just")
        if self.system == "Darwin":
            self.ensure_private_settings()

        self.run(["--tags", "stage-30"])

    def apply_dotfiles(self) -> None:
        self.ensure_sudo()
        just = (self.runtime_bin if self.nixos else self.brew_prefix / "bin") / "just"
        log("Applying chezmoi dotfiles")
        self.command(just, "--justfile", ROOT / "Justfile", "apply")


def refresh_sudo(env: dict[str, str], stop: Event) -> None:
    # Refresh the terminal ticket for installers that call sudo by absolute path
    sudo = env.get("DOTFILES_REAL_SUDO")
    if sudo is None:
        return
    try:
        while not stop.wait(30):
            subprocess.run(
                [sudo, "-A", "-v"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=True,
            )
    except (OSError, subprocess.SubprocessError):
        print("warning: could not refresh sudo credentials", file=sys.stderr)


@dataclass(frozen=True)
class Step:
    name: str
    description: str
    action: Callable[[Workstation], None]
    nixos: bool = False


BOOTSTRAP_STEPS = (
    Step("homebrew", "Prepare Homebrew", Workstation.prepare_homebrew),
    Step("uv", "Install uv", Workstation.install_uv),
    Step("python", "Install Ansible's Python", Workstation.install_python),
    Step("ansible", "Install Ansible", Workstation.install_ansible),
    Step(
        "collections",
        "Install Ansible collections",
        Workstation.install_collections,
        True,
    ),
)
SETUP_STEPS = (
    *BOOTSTRAP_STEPS,
    Step(
        "userland",
        "Install base tools",
        partial(Workstation.run, args=["--tags", "stage-10,stage-20"]),
    ),
    Step("applications", "Install user applications", Workstation.install_applications),
    Step("dotfiles", "Apply chezmoi dotfiles", Workstation.apply_dotfiles, True),
    Step(
        "host",
        "Configure the host",
        partial(Workstation.run, args=["--tags", "host"]),
        True,
    ),
)


def select_steps(host: Workstation, options: argparse.Namespace) -> Iterable[Step]:
    steps = options.steps
    if options.from_step:
        steps = dropwhile(lambda step: step.name != options.from_step, steps)
    if options.only:
        steps = [step for step in steps if step.name in options.only]
    unsupported = []
    if host.nixos and options.only:
        unsupported = [step.name for step in steps if not step.nixos]
    if unsupported:
        raise SetupError(
            f"{', '.join(unsupported)} managed by NixOS; rebuild NixOS instead"
        )
    if host.nixos:
        steps = [step for step in steps if step.nixos]
    return steps


def execute_steps(host: Workstation, options: argparse.Namespace) -> None:
    for step in select_steps(host, options):
        if options.plan:
            print(f"{step.name}: {step.description}")
        else:
            log(step.description)
            step.action(host)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Workstation automation using Python 3.9+; no Python packages required",
        epilog="Use 'run --tags helium' for selected tasks; only bootstrap/setup install dependencies",
        allow_abbrev=False,
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name, description, steps in (
        ("bootstrap", "Prepare or repair Ansible dependencies", BOOTSTRAP_STEPS),
        (
            "setup",
            "Install userland, apply dotfiles, and configure the host",
            SETUP_STEPS,
        ),
    ):
        subparser = subcommands.add_parser(name, help=description, allow_abbrev=False)
        subparser.set_defaults(steps=steps)
        selection = subparser.add_mutually_exclusive_group()
        names = [step.name for step in steps]
        selection.add_argument(
            "--only",
            choices=names,
            nargs="+",
            help="Run only these steps, in setup order; prerequisites must already exist",
        )
        selection.add_argument(
            "--from",
            dest="from_step",
            choices=names,
            help="Resume at this step; earlier steps must already be complete",
        )
        subparser.add_argument(
            "--plan",
            action="store_true",
            help="List selected steps without running commands",
        )
    subparser = subcommands.add_parser(
        "run",
        help="Pass arguments through to ansible-playbook",
        add_help=False,
        allow_abbrev=False,
    )
    options, args = parser.parse_known_args()
    if options.command != "run" and args:
        parser.error(
            f"unrecognized arguments: {' '.join(args)}; use run for Ansible options"
        )
    if args[:1] == ["--"]:
        args = args[1:]
    if sys.version_info < (3, 9):  # ruff: ignore[outdated-version-block]
        parser.error("Python 3.9 or newer is required")
    if os.geteuid() == 0:
        parser.error("do not run as root; privileged tasks use sudo")
    with ExitStack() as resources:
        host = Workstation(resources)
        if options.command == "run":
            host.run(args)
        else:
            execute_steps(host, options)


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
