"""Versioned machine interface for Ansible-owned Python operations."""

import sys
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stdout
from contextvars import ContextVar

from cyclopts.exceptions import CycloptsError
from pydantic import ValidationError

from workstation.automation_models import (
    OperationRequest,
    OperationResponse,
    OperationResult,
)
from workstation.errors import DotfilesError

_REQUEST: ContextVar[OperationRequest | None] = ContextVar(
    "dotfiles_automation_request", default=None
)

_ALLOWED_COMMANDS = {
    ("apps", "install-ghostty-tip-linux"),
    ("apps", "install-ghostty-tip-macos"),
    ("apps", "install-helium-linux"),
    ("apps", "install-helium-macos"),
    ("host", "apps", "rustdesk-tailscale"),
    ("host", "apps", "tailscale-bluefin"),
    ("macos", "kanata"),
    ("macos", "karabiner-vhid"),
}


def current_request() -> OperationRequest | None:
    """Return the active machine request, if the function was called by Ansible."""
    return _REQUEST.get()


def automation_check_mode() -> bool:
    """Whether the active machine request is a no-write check-mode invocation."""
    request = current_request()
    return request.check if request is not None else False


@contextmanager
def _request_scope(request: OperationRequest) -> Iterator[None]:
    token = _REQUEST.set(request)
    try:
        yield
    finally:
        _REQUEST.reset(token)


def _require_allowed_command(command: list[str]) -> None:
    if not any(tuple(command[: len(prefix)]) == prefix for prefix in _ALLOWED_COMMANDS):
        raise DotfilesError(
            f"command is not exposed to Ansible automation: {' '.join(command)}"
        )


def dispatch(request: OperationRequest) -> OperationResponse:
    """Execute a command through the shared parser and normalize its result."""
    if request.command[0] == "_ansible-v1":
        raise DotfilesError("the machine endpoint cannot invoke itself")
    _require_allowed_command(request.command)
    command = " ".join(request.command)
    from workstation.cli import app

    with _request_scope(request):
        command_function, bound, _ = app.parse_args(request.command)
        result = command_function(*bound.args, **bound.kwargs)
    if not isinstance(result, OperationResult):
        raise DotfilesError(
            f"automation command did not return OperationResult: {command}"
        )
    return OperationResponse(**result.model_dump())


def _failure(message: str) -> OperationResponse:
    return OperationResponse(failed=True, msg=message)


def run_machine_protocol(payload: str) -> OperationResponse:
    """Execute one JSON payload without leaking exceptions into the wire format."""
    try:
        request = OperationRequest.model_validate_json(payload)
        return dispatch(request)
    except (CycloptsError, DotfilesError, ValidationError) as error:
        return _failure(str(error))
    except Exception as error:  # ruff:ignore[blind-except] - preserve JSON protocol.
        return _failure(f"unexpected automation failure: {error}")


def machine_entrypoint() -> None:
    """Read one request from stdin and emit exactly one response on stdout."""
    output = sys.stdout
    payload = sys.stdin.read()
    with redirect_stdout(sys.stderr):
        response = run_machine_protocol(payload)
    output.write(response.model_dump_json(exclude_none=True) + "\n")
