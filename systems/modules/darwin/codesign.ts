#!/usr/bin/env bun
import { join } from "node:path";
import { requireCommands, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { object } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { argument, flag, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect, FileSystem } from "effect";
import { parseDarwinOptions } from "./cli.ts";

export const DOTFILES_SIGNING_IDENTITY = "Kanata Local Code Signing";

const codesign = "/usr/bin/codesign";
const security = "/usr/bin/security";
const systemKeychain = "/Library/Keychains/System.keychain";
const certificateKeySpec = "rsa:3072";
const certificateValidityDays = 3650;

export const signingIdentityAvailable = Effect.fn(function* (
  identity: string,
  keychain: string,
) {
  const result = yield* run(
    [security, "find-identity", "-v", "-p", "codesigning", keychain],
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
  yield* requireCommands(codesign, security, "openssl");
  if (yield* signingIdentityAvailable(identity, keychain)) return false;
  if (!(yield* fs.exists(keychain)) || (yield* fs.stat(keychain)).type !== "File")
    return yield* Effect.fail(
      new DotfilesError(`code-signing keychain does not exist: ${keychain}`),
    );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "dotfiles-codesign-",
      });
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
          certificateKeySpec,
          "-nodes",
          "-keyout",
          privateKey,
          "-x509",
          "-sha256",
          "-days",
          String(certificateValidityDays),
          "-out",
          certificate,
          "-config",
          config,
        ],
        { capture: true },
      );
      yield* run([security, "import", privateKey, "-k", keychain, "-T", codesign], {
        capture: true,
      });
      yield* run(
        [
          security,
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
    !(yield* fs.exists(codesign))
  )
    return false;
  const result = yield* run([codesign, "-dvv", bundle], {
    check: false,
    capture: true,
  });
  if (
    result.code !== 0 ||
    !result.stderr.split("\n").some((line) => line.trim() === `Authority=${identity}`)
  )
    return false;
  return (
    (yield* run([codesign, "--verify", "--deep", "--strict", bundle], {
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
      codesign,
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
  yield* run([codesign, "--verify", "--deep", "--strict", bundle], {
    capture: true,
  });
  if (!(yield* bundleHasSigningIdentity(bundle, identity)))
    return yield* Effect.fail(
      new DotfilesError(
        `bundle did not retain code-signing identity ${identity}: ${bundle}`,
      ),
    );
});

const parser = object({
  bundle: argument(string({ metavar: "BUNDLE" })),
  identity: option("--identity", string({ metavar: "NAME" }))
    .multiple()
    .map((values) => values.at(-1) ?? DOTFILES_SIGNING_IDENTITY),
  keychain: option("--keychain", string({ metavar: "PATH" }))
    .multiple()
    .map((values) => values.at(-1) ?? systemKeychain),
  administratorTrust: flag("--administrator-trust")
    .multiple()
    .map((values) => values.length > 0),
  entitlements: option("--entitlements", string({ metavar: "PATH" }))
    .multiple()
    .map((values) => values.at(-1)),
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const values = yield* Effect.try({
        try: () =>
          parseDarwinOptions(
            parser,
            "bun codesign.ts",
            Bun.argv.slice(2),
            message`Sign an application bundle with the local identity`,
          ),
        catch: (cause) => new DotfilesError(String(cause)),
      });
      if (!values) return;
      const { bundle } = values;
      // Apply explicit entitlements even when the bundle already has our identity
      if (
        values.entitlements ||
        !(yield* bundleHasSigningIdentity(bundle, values.identity))
      ) {
        yield* ensureSigningIdentity(
          values.identity,
          values.keychain,
          values.administratorTrust,
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
