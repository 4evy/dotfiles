#!/usr/bin/python

# Copyright: 4evy
# MIT License (see LICENSE or https://opensource.org/license/mit)


DOCUMENTATION = r"""
---
module: dotfiles_operation
short_description: Run a repository-owned dotfiles Python operation
version_added: "0.1.0"
description:
  - Executes the versioned machine interface exposed by C(dotfiles-scripts).
  - Keeps project dependencies in their isolated uv tool environment while
    returning native Ansible result fields.
options:
  executable:
    description: Absolute path to the C(dotfiles-scripts) executable.
    type: path
    required: true
  command:
    description:
      - Existing C(dotfiles-scripts) command and arguments.
      - Cyclopts performs the same discovery and type conversion as the human CLI.
      - Must contain at least one argument.
    type: list
    elements: str
    required: true
  context:
    description: Selected host and repository context passed to the operation.
    type: dict
    required: true
  chdir:
    description: Working directory used to execute the operation.
    type: path
  environment:
    description:
      - Environment additions for the isolated operation process.
      - Keys and values must be strings.
    type: dict
    default: {}
attributes:
  check_mode:
    support: full
    description: The Python operation receives check-mode state in its typed request.
  diff_mode:
    support: full
    description: Structured operation diffs are forwarded to Ansible unchanged.
author:
  - 4evy (@4evy)
"""

EXAMPLES = r"""
- name: Configure Tailscale host policy through the repository Python runtime
  dotfiles_operation:
    executable: "{{ dotfiles_bin_dir }}/dotfiles-scripts"
    command: [host, tailscale, configure-bluefin]
    context:
      repo_root: "{{ dotfiles_repo_root }}"
      home: "{{ dotfiles_home_dir }}"
      system: "{{ ansible_facts.system }}"
      architecture: "{{ ansible_facts.architecture }}"
  register: tailscale_policy
"""

RETURN = r"""
data:
  description: Operation-specific structured result data.
  returned: success
  type: dict
  sample:
    installed: true
msg:
  description: Human-readable operation summary.
  returned: always
  type: str
warnings:
  description: Non-fatal warnings reported by the operation.
  returned: when present
  type: list
  elements: str
protocol:
  description: Machine protocol version used for this invocation.
  returned: always
  type: int
  sample: 1
operation_stderr:
  description: Standard error captured from the operation process.
  returned: always
  type: str
"""

import json
import os
import pathlib

from ansible.module_utils.basic import AnsibleModule  # ty: ignore[unresolved-import]

PROTOCOL_VERSION = 1


def _request(module: AnsibleModule) -> str:
    payload = {
        "protocol": PROTOCOL_VERSION,
        "command": module.params["command"],
        "context": module.params["context"],
        "check": module.check_mode,
        "diff": bool(getattr(module, "_diff", False)),
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _parse_response(
    module: AnsibleModule,
    *,
    rc: int,
    stdout: str,
    stderr: str,
) -> dict[str, object]:
    try:
        response = json.loads(stdout)
    except json.JSONDecodeError:
        module.fail_json(
            msg="dotfiles operation did not return valid JSON",
            rc=rc,
            stdout=stdout,
            stderr=stderr,
        )
        return {}
    if not isinstance(response, dict) or response.get("protocol") != PROTOCOL_VERSION:
        module.fail_json(
            msg="dotfiles operation returned an unsupported protocol response",
            rc=rc,
            stdout=stdout,
            stderr=stderr,
        )
        return {}
    return response


def _validate_environment(module: AnsibleModule) -> dict[str, str]:
    environment = module.params["environment"]
    if not isinstance(environment, dict) or not all(
        isinstance(name, str) and isinstance(value, str)
        for name, value in environment.items()
    ):
        module.fail_json(msg="environment keys and values must be strings")
    return environment


def _validate_command(module: AnsibleModule) -> None:
    if not module.params["command"]:
        module.fail_json(msg="command must contain at least one argument")


def run_module() -> None:
    module = AnsibleModule(
        argument_spec={
            "executable": {"type": "path", "required": True},
            "command": {"type": "list", "elements": "str", "required": True},
            "context": {"type": "dict", "required": True},
            "chdir": {"type": "path"},
            "environment": {"type": "dict", "default": {}},
        },
        supports_check_mode=True,
    )
    _validate_command(module)
    executable = module.params["executable"]
    if not pathlib.Path(executable).is_file() or not os.access(executable, os.X_OK):
        module.fail_json(
            msg=f"dotfiles operation executable is unavailable: {executable}"
        )
    rc, stdout, stderr = module.run_command(
        [executable, "_ansible-v1"],
        data=_request(module),
        binary_data=True,
        cwd=module.params["chdir"],
        environ_update=_validate_environment(module),
        check_rc=False,
        expand_user_and_vars=False,
        ignore_invalid_cwd=False,
    )
    response = _parse_response(module, rc=rc, stdout=stdout, stderr=stderr)
    response["operation_stderr"] = stderr
    warnings = response.pop("warnings", [])
    if isinstance(warnings, list):
        for warning in warnings:
            module.warn(str(warning))
    if rc != 0 or response.pop("failed", False):
        response["rc"] = rc
        module.fail_json(
            msg=response.pop("msg", None) or "dotfiles operation failed",
            **response,
        )
    module.exit_json(**response)


def main() -> None:
    run_module()


if __name__ == "__main__":
    main()
