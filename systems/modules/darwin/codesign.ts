#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const DOTFILES_SIGNING_IDENTITY = "Kanata Local Code Signing";

function run(arguments_: string[], check = true) {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (check && result.exitCode !== 0) {
    throw new Error(
      `command failed (${result.exitCode}): ${arguments_[0]}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { exitCode: result.exitCode, stdout, stderr };
}

export function signingIdentityAvailable(identity: string, keychain: string): boolean {
  const result = run(
    ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning", keychain],
    false,
  );
  return (
    result.exitCode === 0 &&
    result.stdout.split("\n").some((line) => line.includes(identity))
  );
}

export function ensureSigningIdentity(
  identity: string,
  keychain: string,
  administratorTrust = false,
): boolean {
  for (const command of ["/usr/bin/codesign", "/usr/bin/security", "openssl"]) {
    if (!Bun.which(command))
      throw new Error(`required command is not available: ${command}`);
  }
  if (signingIdentityAvailable(identity, keychain)) return false;
  if (!existsSync(keychain) || !statSync(keychain).isFile()) {
    throw new Error(`code-signing keychain does not exist: ${keychain}`);
  }
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codesign-"));
  try {
    const config = join(root, "codesign-openssl.cnf");
    const privateKey = join(root, "identity.key");
    const certificate = join(root, "identity.crt");
    writeFileSync(
      config,
      `[ req ]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[ dn ]
CN = ${identity.replaceAll("\\", "\\\\").replaceAll("\n", " ")}

[ v3_req ]
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
basicConstraints = critical, CA:false
`,
    );
    run([
      "openssl",
      "req",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-keyout",
      privateKey,
      "-x509",
      "-sha256",
      "-days",
      "3650",
      "-out",
      certificate,
      "-config",
      config,
    ]);
    run([
      "/usr/bin/security",
      "import",
      privateKey,
      "-k",
      keychain,
      "-T",
      "/usr/bin/codesign",
    ]);
    run([
      "/usr/bin/security",
      "add-trusted-cert",
      ...(administratorTrust ? ["-d"] : []),
      "-r",
      "trustRoot",
      "-p",
      "codeSign",
      "-k",
      keychain,
      certificate,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (!signingIdentityAvailable(identity, keychain)) {
    throw new Error(`created code-signing identity is invalid: ${identity}`);
  }
  return true;
}

export function bundleHasSigningIdentity(bundle: string, identity: string): boolean {
  if (
    !existsSync(bundle) ||
    !statSync(bundle).isDirectory() ||
    !existsSync("/usr/bin/codesign")
  )
    return false;
  const result = run(["/usr/bin/codesign", "-dvv", bundle], false);
  if (
    result.exitCode !== 0 ||
    !result.stderr.split("\n").some((line) => line.trim() === `Authority=${identity}`)
  )
    return false;
  return (
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", bundle], false)
      .exitCode === 0
  );
}

export function signBundle(
  bundle: string,
  identity: string,
  keychain: string,
  entitlements?: string,
): void {
  if (!existsSync(bundle) || !statSync(bundle).isDirectory()) {
    throw new Error(`application bundle does not exist: ${bundle}`);
  }
  run([
    "/usr/bin/codesign",
    "--deep",
    "--force",
    "--keychain",
    keychain,
    "--options",
    "runtime",
    entitlements
      ? "--preserve-metadata=identifier"
      : "--preserve-metadata=identifier,entitlements",
    ...(entitlements ? ["--entitlements", entitlements] : []),
    "--sign",
    identity,
    "--timestamp=none",
    bundle,
  ]);
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", bundle]);
  if (!bundleHasSigningIdentity(bundle, identity)) {
    throw new Error(
      `bundle did not retain code-signing identity ${identity}: ${bundle}`,
    );
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      identity: { type: "string", default: DOTFILES_SIGNING_IDENTITY },
      keychain: { type: "string", default: "/Library/Keychains/System.keychain" },
      "administrator-trust": { type: "boolean", default: false },
      entitlements: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun codesign.ts BUNDLE [--identity NAME] [--keychain PATH] [--administrator-trust] [--entitlements PATH]",
    );
  } else {
    const [bundle] = positionals;
    if (!bundle || positionals.length !== 1)
      throw new Error("Expected one application bundle path");
    // Apply explicit entitlements even when the bundle already has our identity
    if (values.entitlements || !bundleHasSigningIdentity(bundle, values.identity)) {
      ensureSigningIdentity(
        values.identity,
        values.keychain,
        values["administrator-trust"],
      );
      signBundle(bundle, values.identity, values.keychain, values.entitlements);
    }
  }
}
