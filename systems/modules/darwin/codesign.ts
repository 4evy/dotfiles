#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { requireCommands, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem } from "effect";

export const DOTFILES_SIGNING_IDENTITY = "Kanata Local Code Signing";

export const signingIdentityAvailable = Effect.fn(function* (
  identity: string,
  keychain: string,
) {
  const result = yield* run(
    ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning", keychain],
    { check: false, capture: true },
  );
  return (
    result.code === 0 &&
    result.stdout.split("\n").some((line) => line.includes(identity))
  );
});

export const ensureSigningIdentity = Effect.fn(function* (
  identity: string,
  keychain: string,
  administratorTrust = false,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* requireCommands("/usr/bin/codesign", "/usr/bin/security", "openssl");
  if (yield* signingIdentityAvailable(identity, keychain)) return false;
  if (!(yield* fs.exists(keychain)) || (yield* fs.stat(keychain)).type !== "File")
    return yield* Effect.fail(
      new DotfilesError(`code-signing keychain does not exist: ${keychain}`),
    );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-codesign-" });
      const config = join(root, "codesign-openssl.cnf");
      const privateKey = join(root, "identity.key");
      const certificate = join(root, "identity.crt");
      yield* fs.writeFileString(
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
      yield* run(
        [
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
        ],
        { capture: true },
      );
      yield* run(
        [
          "/usr/bin/security",
          "import",
          privateKey,
          "-k",
          keychain,
          "-T",
          "/usr/bin/codesign",
        ],
        { capture: true },
      );
      yield* run(
        [
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
        ],
        { capture: true },
      );
    }),
  );
  if (!(yield* signingIdentityAvailable(identity, keychain)))
    return yield* Effect.fail(
      new DotfilesError(`created code-signing identity is invalid: ${identity}`),
    );
  return true;
});

export const bundleHasSigningIdentity = Effect.fn(function* (
  bundle: string,
  identity: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (
    !(yield* fs.exists(bundle)) ||
    (yield* fs.stat(bundle)).type !== "Directory" ||
    !(yield* fs.exists("/usr/bin/codesign"))
  )
    return false;
  const result = yield* run(["/usr/bin/codesign", "-dvv", bundle], {
    check: false,
    capture: true,
  });
  if (
    result.code !== 0 ||
    !result.stderr.split("\n").some((line) => line.trim() === `Authority=${identity}`)
  )
    return false;
  return (
    (yield* run(["/usr/bin/codesign", "--verify", "--deep", "--strict", bundle], {
      check: false,
      capture: true,
    })).code === 0
  );
});

export const signBundle = Effect.fn(function* (
  bundle: string,
  identity: string,
  keychain: string,
  entitlements?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(bundle)) || (yield* fs.stat(bundle)).type !== "Directory")
    return yield* Effect.fail(
      new DotfilesError(`application bundle does not exist: ${bundle}`),
    );
  yield* run(
    [
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
    ],
    { capture: true },
  );
  yield* run(["/usr/bin/codesign", "--verify", "--deep", "--strict", bundle], {
    capture: true,
  });
  if (!(yield* bundleHasSigningIdentity(bundle, identity)))
    return yield* Effect.fail(
      new DotfilesError(
        `bundle did not retain code-signing identity ${identity}: ${bundle}`,
      ),
    );
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const { values, positionals } = yield* Effect.try({
        try: () =>
          parseArgs({
            args: Bun.argv.slice(2),
            allowPositionals: true,
            options: {
              identity: { type: "string", default: DOTFILES_SIGNING_IDENTITY },
              keychain: {
                type: "string",
                default: "/Library/Keychains/System.keychain",
              },
              "administrator-trust": { type: "boolean", default: false },
              entitlements: { type: "string" },
              help: { type: "boolean", short: "h" },
            },
          }),
        catch: (cause) => new DotfilesError(String(cause)),
      });
      if (values.help) {
        console.log(
          "Usage: bun codesign.ts BUNDLE [--identity NAME] [--keychain PATH] [--administrator-trust] [--entitlements PATH]",
        );
        return;
      }
      const [bundle] = positionals;
      if (!bundle || positionals.length !== 1)
        return yield* Effect.fail(
          new DotfilesError("Expected one application bundle path"),
        );
      // Apply explicit entitlements even when the bundle already has our identity
      if (
        values.entitlements ||
        !(yield* bundleHasSigningIdentity(bundle, values.identity))
      ) {
        yield* ensureSigningIdentity(
          values.identity,
          values.keychain,
          values["administrator-trust"],
        );
        yield* signBundle(
          bundle,
          values.identity,
          values.keychain,
          values.entitlements,
        );
      }
    }),
  );
