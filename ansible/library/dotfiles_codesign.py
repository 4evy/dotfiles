#!/usr/bin/python
"""Ensure a macOS application bundle has a stable local signing identity."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from pathlib import Path

try:
    from ansible.module_utils.basic import (  # ty: ignore[unresolved-import]
        AnsibleModule,
    )
except ModuleNotFoundError:
    AnsibleModule = None  # type: ignore[assignment,misc]

DOCUMENTATION = r"""
---
module: dotfiles_codesign
short_description: Sign a local macOS application bundle with a stable identity
description:
  - Creates a local signing identity when necessary and signs an application bundle.
author: 4evy
options:
  bundle:
    description: Application bundle to sign.
    required: true
    type: path
  identity:
    description: Common name of the local code-signing identity.
    required: true
    type: str
  keychain:
    description: Keychain that owns the identity.
    required: true
    type: path
  administrator_trust:
    description: Add the generated certificate to the administrator trust domain.
    type: bool
    default: false
supports_check_mode: true
"""

EXAMPLES = r"""
- name: Keep an application signed with the local workstation identity
  dotfiles_codesign:
    bundle: /Applications/Example.app
    identity: Dotfiles Local Code Signing
    keychain: /Library/Keychains/System.keychain
"""

RETURN = r"""
identity_created:
  description: Whether a new signing identity was created.
  returned: success
  type: bool
"""

DOTFILES_SIGNING_IDENTITY = "Kanata Local Code Signing"


class CodesignError(RuntimeError):
    """A local identity could not be created or applied."""


def run(
    arguments: Sequence[str | Path], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    """Run one signing command without involving a shell."""
    result = subprocess.run(
        tuple(map(str, arguments)),
        check=False,
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise CodesignError(
            f"command failed ({result.returncode}): {arguments[0]}: {message}"
        )
    return result


def signing_identity_available(identity: str, keychain: Path) -> bool:
    """Return whether the keychain contains a valid code-signing identity."""
    result = run(
        (
            "/usr/bin/security",
            "find-identity",
            "-v",
            "-p",
            "codesigning",
            keychain,
        ),
        check=False,
    )
    return result.returncode == 0 and any(
        identity in line for line in result.stdout.splitlines()
    )


def _openssl_config(identity: str) -> str:
    escaped_identity = identity.replace("\\", "\\\\").replace("\n", " ")
    return f"""[ req ]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[ dn ]
CN = {escaped_identity}

[ v3_req ]
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
basicConstraints = critical, CA:false
"""


def ensure_signing_identity(
    identity: str,
    keychain: Path,
    *,
    administrator_trust: bool = False,
) -> bool:
    """Create a ten-year local code-signing identity when it is absent."""
    for command in ("/usr/bin/codesign", "/usr/bin/security", "openssl"):
        if shutil.which(command) is None:
            raise CodesignError(f"required command is not available: {command}")
    if signing_identity_available(identity, keychain):
        return False
    if not keychain.is_file():
        raise CodesignError(f"code-signing keychain does not exist: {keychain}")

    with tempfile.TemporaryDirectory(prefix="dotfiles-codesign-") as temporary:
        root = Path(temporary)
        openssl_config = root / "codesign-openssl.cnf"
        openssl_config.write_text(_openssl_config(identity), encoding="utf-8")
        private_key = root / "identity.key"
        certificate = root / "identity.crt"
        run((
            "openssl",
            "req",
            "-newkey",
            "rsa:3072",
            "-nodes",
            "-keyout",
            private_key,
            "-x509",
            "-sha256",
            "-days",
            "3650",
            "-out",
            certificate,
            "-config",
            openssl_config,
        ))
        run((
            "/usr/bin/security",
            "import",
            private_key,
            "-k",
            keychain,
            "-T",
            "/usr/bin/codesign",
        ))
        trust_arguments: list[str | Path] = [
            "/usr/bin/security",
            "add-trusted-cert",
        ]
        if administrator_trust:
            trust_arguments.append("-d")
        trust_arguments.extend((
            "-r",
            "trustRoot",
            "-p",
            "codeSign",
            "-k",
            keychain,
            certificate,
        ))
        run(trust_arguments)

    if not signing_identity_available(identity, keychain):
        raise CodesignError(f"created code-signing identity is invalid: {identity}")
    return True


def bundle_has_signing_identity(bundle: Path, identity: str) -> bool:
    """Return whether the bundle has a valid deep signature from the identity."""
    if not bundle.is_dir() or not Path("/usr/bin/codesign").is_file():
        return False
    result = run(("/usr/bin/codesign", "-dvv", bundle), check=False)
    authority_matches = result.returncode == 0 and any(
        line.strip() == f"Authority={identity}" for line in result.stderr.splitlines()
    )
    if not authority_matches:
        return False
    verification = run(
        ("/usr/bin/codesign", "--verify", "--deep", "--strict", bundle),
        check=False,
    )
    return verification.returncode == 0


def sign_bundle(bundle: Path, identity: str, keychain: Path) -> None:
    """Sign a bundle while retaining its identifier and entitlements."""
    if not bundle.is_dir():
        raise CodesignError(f"application bundle does not exist: {bundle}")
    run((
        "/usr/bin/codesign",
        "--deep",
        "--force",
        "--keychain",
        keychain,
        "--options",
        "runtime",
        "--preserve-metadata=identifier,entitlements",
        "--sign",
        identity,
        "--timestamp=none",
        bundle,
    ))
    run(("/usr/bin/codesign", "--verify", "--deep", "--strict", bundle))
    if not bundle_has_signing_identity(bundle, identity):
        raise CodesignError(
            f"bundle did not retain code-signing identity {identity}: {bundle}"
        )


def main() -> None:
    """Run the module through Ansible's JSON transport."""
    if AnsibleModule is None:
        raise RuntimeError("dotfiles_codesign must be run by Ansible")
    module = AnsibleModule(
        argument_spec={
            "bundle": {"type": "path", "required": True},
            "identity": {"type": "str", "required": True},
            "keychain": {"type": "path", "required": True},
            "administrator_trust": {"type": "bool", "default": False},
        },
        supports_check_mode=True,
    )
    bundle = Path(module.params["bundle"])
    identity = module.params["identity"]
    keychain = Path(module.params["keychain"])
    if bundle_has_signing_identity(bundle, identity):
        module.exit_json(changed=False, identity_created=False)
    if module.check_mode:
        module.exit_json(changed=True, identity_created=False)
    identity_created = False
    try:
        identity_created = ensure_signing_identity(
            identity,
            keychain,
            administrator_trust=module.params["administrator_trust"],
        )
        sign_bundle(bundle, identity, keychain)
    except CodesignError as error:
        module.fail_json(msg=str(error))
    module.exit_json(changed=True, identity_created=identity_created)


if __name__ == "__main__":
    main()
