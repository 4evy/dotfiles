"""Stable local code-signing identities for macOS-managed applications."""

import tempfile
from pathlib import Path

from workstation.errors import DotfilesError
from workstation.lib.commands import require_commands, run
from workstation.lib.paths import asset_path
from workstation.lib.templates import render_template

# This historical name is already the root-owned identity used for Kanata.
# Keep it stable: TCC designated requirements include the certificate leaf.
DOTFILES_SIGNING_IDENTITY = "Kanata Local Code Signing"
SYSTEM_KEYCHAIN = Path("/Library/Keychains/System.keychain")


def signing_identity_available(identity: str, keychain: Path) -> bool:
    """Whether ``keychain`` contains a currently valid code-signing identity."""
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
        capture=True,
    )
    return result.returncode == 0 and any(
        identity in line for line in result.stdout.splitlines()
    )


def ensure_signing_identity(
    identity: str,
    keychain: Path,
    *,
    administrator_trust: bool = False,
) -> bool:
    """Create a ten-year, local-only code-signing identity when absent.

    The unencrypted private key exists only inside a mode-0700 temporary
    directory and is imported directly into the destination keychain. Avoiding
    a PKCS#12 transport archive means no password—especially not the user's
    login password—appears in a process argument.

    Returns ``True`` when a new identity was created.
    """
    require_commands("/usr/bin/codesign", "/usr/bin/security", "openssl")
    if signing_identity_available(identity, keychain):
        return False

    if not keychain.is_file():
        raise DotfilesError(f"code-signing keychain does not exist: {keychain}")

    with tempfile.TemporaryDirectory(prefix="dotfiles-codesign-") as temporary:
        root = Path(temporary)
        openssl_config = root / "codesign-openssl.cnf"
        render_template(
            asset_path("macos", "templates", "local-codesign-openssl.cnf.in"),
            openssl_config,
            {"identity": identity},
        )
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
        raise DotfilesError(f"created code-signing identity is not valid: {identity}")
    return True


def bundle_has_signing_identity(
    bundle: Path,
    identity: str,
) -> bool:
    """Whether a bundle's leaf signing authority has the expected name."""
    if not bundle.is_dir() or not Path("/usr/bin/codesign").is_file():
        return False
    result = run(
        ("/usr/bin/codesign", "-dvv", bundle),
        check=False,
        capture=True,
    )
    authority_matches = result.returncode == 0 and any(
        line.strip() == f"Authority={identity}" for line in result.stderr.splitlines()
    )
    if not authority_matches:
        return False
    verification = run(
        (
            "/usr/bin/codesign",
            "--verify",
            "--deep",
            "--strict",
            bundle,
        ),
        check=False,
        capture=True,
    )
    return verification.returncode == 0


def sign_bundle(bundle: Path, identity: str, keychain: Path) -> None:
    """Sign a bundle while retaining its identifier and entitlements."""
    if not bundle.is_dir():
        raise DotfilesError(f"application bundle does not exist: {bundle}")
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
    run((
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        bundle,
    ))
    if not bundle_has_signing_identity(bundle, identity):
        raise DotfilesError(
            f"bundle did not retain code-signing identity {identity}: {bundle}"
        )
