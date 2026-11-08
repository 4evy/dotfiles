import { DotfilesError } from "@dotfiles/core/errors";
import { download } from "@dotfiles/core/http";
import { Effect, FileSystem, Schema } from "effect";

const archiveIntegrityAlgorithm = "sha512";

export const readManifest = Effect.fn(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  )(yield* fs.readFileString(path));
});

export const downloadArchive = Effect.fn(function* (
  dist: { readonly tarball: string; readonly integrity: string },
  name: string,
) {
  yield* Schema.decodeUnknownEffect(Schema.URLFromString)(dist.tarball);
  const archive = new Uint8Array(
    yield* download(dist.tarball, (response) => response.arrayBuffer),
  );
  const integrity = `${archiveIntegrityAlgorithm}-${new Bun.CryptoHasher(archiveIntegrityAlgorithm).update(archive).digest("base64")}`;
  if (integrity !== dist.integrity)
    return yield* Effect.fail(
      new DotfilesError(`${name} archive integrity check failed`),
    );
  return archive;
});
