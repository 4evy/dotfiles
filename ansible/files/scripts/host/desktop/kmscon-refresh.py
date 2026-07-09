#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile

LOGINCTL = "/usr/bin/loginctl"
SYSTEMCTL = "/usr/bin/systemctl"
KMSCON_TTYS = tuple(f"tty{number}" for number in range(1, 7))
DEFAULT_STATE = pathlib.Path("/run/kmscon-theme-refresh.json")


def command_output(argv: tuple[str, ...]) -> str:
    return subprocess.run(
        argv,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def session_ids() -> tuple[str, ...]:
    output = command_output((LOGINCTL, "list-sessions", "--no-legend", "--no-pager"))
    return tuple(
        line.split(maxsplit=1)[0] for line in output.splitlines() if line.split()
    )


def session_tty(session_id: str) -> str | None:
    output = command_output((
        LOGINCTL,
        "show-session",
        session_id,
        "--property=TTY",
        "--property=VTNr",
    ))
    properties = dict(
        line.split("=", maxsplit=1) for line in output.splitlines() if "=" in line
    )
    tty = properties.get("TTY", "")
    if tty in KMSCON_TTYS:
        return tty
    vt_number = properties.get("VTNr", "")
    candidate = f"tty{vt_number}"
    return candidate if candidate in KMSCON_TTYS else None


def logged_in_ttys() -> set[str]:
    return {tty for session_id in session_ids() if (tty := session_tty(session_id))}


def config_digest(config: pathlib.Path) -> str:
    return hashlib.sha256(config.read_bytes()).hexdigest()


def load_pending(state_path: pathlib.Path, digest: str) -> set[str]:
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return set(KMSCON_TTYS)
    except OSError:
        return set(KMSCON_TTYS)
    if state.get("config_sha256") != digest:
        return set(KMSCON_TTYS)
    pending = state.get("pending_ttys")
    if not isinstance(pending, list):
        return set(KMSCON_TTYS)
    return {tty for tty in pending if tty in KMSCON_TTYS}


def write_state(state_path: pathlib.Path, digest: str, pending: set[str]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(
        {"config_sha256": digest, "pending_ttys": sorted(pending)},
        indent=2,
        sort_keys=True,
    )
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=state_path.parent, delete=False
    ) as handle:
        handle.write(f"{content}\n")
        temporary = pathlib.Path(handle.name)
    temporary.chmod(0o644)
    temporary.replace(state_path)


def refresh(config: pathlib.Path, state_path: pathlib.Path) -> int:
    digest = config_digest(config)
    pending = load_pending(state_path, digest)
    if not pending:
        return 0

    occupied = logged_in_ttys()
    remaining = pending & occupied
    failed = False
    for tty in sorted(pending - occupied):
        result = subprocess.run(
            (SYSTEMCTL, "try-restart", f"kmsconvt@{tty}.service"),
            check=False,
        )
        if result.returncode != 0:
            remaining.add(tty)
            failed = True

    write_state(state_path, digest, remaining)
    return 1 if failed else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=pathlib.Path)
    parser.add_argument("--state", type=pathlib.Path, default=DEFAULT_STATE)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return refresh(args.config, args.state)


if __name__ == "__main__":
    raise SystemExit(main())
