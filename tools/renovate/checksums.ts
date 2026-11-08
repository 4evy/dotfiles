import { join } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeIfChanged } from "@dotfiles/core/files";
import { download } from "@dotfiles/core/http";
import { Effect, FileSystem, Schema } from "effect";
import { root } from "./paths.ts";

const permissionBits = 0o777;
const twpExtensionId = "bolggfoncklhniejomgplkjcllmnonbh";
const twpRepository = "FilipePS/Traduzir-paginas-web";

function parseChecksums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^[ \t]*([a-f\d]{64})[ \t]+\*?(?:\.\/)?(.+?)\s*$/i);
    if (!match?.[1] || !match[2]) continue;
    const hash = match[1].toLowerCase();
    const previous = checksums.get(match[2]);
    if (previous && previous !== hash)
      throw new Error(`Conflicting checksums for ${match[2]}`);
    checksums.set(match[2], hash);
  }
  return checksums;
}

function checksumFor(checksums: Map<string, string>, asset: string): string {
  const hash = checksums.get(asset);
  if (!hash) throw new Error(`Missing checksum for ${asset}`);
  return hash;
}

function replaceOnce(
  content: string,
  pattern: RegExp,
  replacement: (match: RegExpMatchArray) => string,
  description: string,
): string {
  const matches = [...content.matchAll(pattern)];
  const [match] = matches;
  if (matches.length !== 1 || !match) throw new Error(`Expected one ${description}`);
  return (
    content.slice(0, match.index) +
    replacement(match) +
    content.slice(match.index + match[0].length)
  );
}

// TOML/YAML parsers and pure pin rewrites throw, so adapt those boundaries only
const transform = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (cause) => new DotfilesError(String(cause)) });
const githubEnvironment =
  !process.env.GH_TOKEN && process.env.RENOVATE_TOKEN
    ? { GH_TOKEN: process.env.RENOVATE_TOKEN }
    : {};

const releaseAsset = (repository: string, tag: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "release-asset-" });
      const path = join(directory, name);
      // Use the release API, not GitHub's unreliable browser download route
      yield* run(
        [
          "gh",
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--pattern",
          name,
          "--output",
          path,
        ],
        { cwd: root, capture: true, env: githubEnvironment },
      );
      return yield* fs.readFile(path);
    }),
  );

const checksumsAt = Effect.fn(function* (repository: string, tag: string) {
  const bytes = yield* releaseAsset(repository, tag, "SHASUMS256.txt");
  return yield* transform(() => parseChecksums(new TextDecoder().decode(bytes)));
});

export const updateBunBootstrap = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(root, "tools/setup/setup.sh");
  const content = yield* fs.readFileString(path);
  const version = content.match(/releases\/download\/bun-v([^/]+)\//)?.[1];
  if (!version)
    return yield* Effect.fail(new DotfilesError("Missing Bun bootstrap version"));
  const checksums = yield* checksumsAt("oven-sh/bun", `bun-v${version}`);
  const updated = yield* transform(() => {
    let count = 0;
    const updated = content.replace(
      /(^[ \t]*archive=([^\s]+)\r?\n[ \t]*expected=)[^\s]+/gm,
      (_, prefix: string, archive: string) => {
        count++;
        const asset = archive.replace(/^(['"])(.*)\1$/, "$2");
        return `${prefix}${checksumFor(checksums, `${asset}.zip`)}`;
      },
    );
    if (!count || count !== [...content.matchAll(/^[ \t]*archive=/gm)].length)
      throw new Error("Missing Bun bootstrap checksum bindings");
    return updated;
  });
  yield* writeIfChanged(path, updated, (yield* fs.stat(path)).mode & permissionBits);
});

export const updateHomebrewBootstrap = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(root, "tools/setup/setup.ts");
  const content = yield* fs.readFileString(path);
  const revision = content.match(/^const homebrewRevision = "([a-f\d]{40})";$/m)?.[1];
  if (!revision)
    return yield* Effect.fail(new DotfilesError("Missing Homebrew bootstrap revision"));
  const bytes = yield* download(
    `https://raw.githubusercontent.com/Homebrew/install/${revision}/install.sh`,
    (response) => response.arrayBuffer,
  );
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const updated = yield* transform(() =>
    replaceOnce(
      content,
      /(^const homebrewSHA256\s*=\s*")[a-f\d]{64}(")/gm,
      (match) => `${match[1]}${hash}${match[2]}`,
      "Homebrew bootstrap checksum binding",
    ),
  );
  yield* writeIfChanged(path, updated, (yield* fs.stat(path)).mode & permissionBits);
});

const releaseAssets = Schema.Struct({
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
    }),
  ),
});

const releaseAt = Effect.fn(function* (repository: string, tag: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(releaseAssets))(
    yield* output(
      ["gh", "api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],
      {
        cwd: root,
        env: githubEnvironment,
      },
    ),
  );
});

export const updateReleaseAssets = Effect.fn(function* (options: {
  rustdesk: boolean;
  karabiner: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const pins = [
    {
      enabled: options.rustdesk,
      path: "systems/spectrum/recipes/spectrum/modules/software.yml",
      repository: "rustdesk/rustdesk",
      pattern:
        /https:\/\/github\.com\/rustdesk\/rustdesk\/releases\/download\/([^/\s"]+)\/rustdesk-[^/\s"]+\.rpm/g,
      assetName: (tag: string) => `rustdesk-${tag}-0.x86_64.rpm`,
      sourceUrl: (tag: string, name: string) =>
        `https://github.com/rustdesk/rustdesk/releases/download/${tag}/${name}`,
    },
    {
      enabled: options.karabiner,
      path: "flake.nix",
      repository: "pqrs-org/Karabiner-DriverKit-VirtualHIDDevice",
      pattern:
        /file\+https:\/\/raw\.githubusercontent\.com\/pqrs-org\/Karabiner-DriverKit-VirtualHIDDevice\/([^/\s"]+)\/dist\/Karabiner-DriverKit-VirtualHIDDevice-[^/\s"]+\.pkg/g,
      assetName: (tag: string) =>
        `Karabiner-DriverKit-VirtualHIDDevice-${tag.replace(/^v/, "")}.pkg`,
      sourceUrl: (tag: string, name: string) =>
        `file+https://raw.githubusercontent.com/pqrs-org/Karabiner-DriverKit-VirtualHIDDevice/${tag}/dist/${name}`,
    },
  ];
  for (const pin of pins) {
    if (!pin.enabled) continue;
    const path = join(root, pin.path);
    const content = yield* fs.readFileString(path);
    const tag = yield* transform(() => {
      const matches = [...content.matchAll(pin.pattern)];
      if (matches.length !== 1 || !matches[0]?.[1])
        throw new Error(`Expected one ${pin.repository} release URL`);
      return matches[0][1];
    });
    const release = yield* releaseAt(pin.repository, tag);
    const url = yield* transform(() => {
      const name = pin.assetName(tag);
      const assets = release.assets.filter((asset) => asset.name === name);
      const [asset] = assets;
      if (assets.length !== 1 || !asset)
        throw new Error(`Expected one ${name} release asset`);
      const url = new URL(asset.browser_download_url);
      if (
        url.origin !== "https://github.com" ||
        url.pathname !== `/${pin.repository}/releases/download/${tag}/${name}`
      )
        throw new Error(`Unexpected release download URL for ${name}`);
      return pin.sourceUrl(tag, name);
    });
    const updated = yield* transform(() =>
      replaceOnce(content, pin.pattern, () => url, `${pin.repository} release URL`),
    );
    yield* writeIfChanged(path, updated);
  }
});

export const updateMise = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(root, ".github/actions/setup/check/tools/action.yaml");
  const content = yield* fs.readFileString(path);
  const action = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      runs: Schema.Struct({
        steps: Schema.Array(
          Schema.Struct({
            env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ),
      }),
    }),
  )(yield* transform(() => Bun.YAML.parse(content)));
  const installers = action.runs.steps.filter(
    (step) => step.env?.MISE_VERSION !== undefined,
  );
  const [installer] = installers;
  if (installers.length !== 1)
    return yield* Effect.fail(new DotfilesError("Expected one mise install step"));
  const version = installer?.env?.MISE_VERSION;
  if (typeof version !== "string" || !/^v\S+$/.test(version))
    return yield* Effect.fail(new DotfilesError("Missing mise bootstrap version"));
  const checksums = yield* checksumsAt("jdx/mise", version);
  const updated = yield* transform(() => {
    let updated = content;
    for (const [runner, platform] of Object.entries({
      LINUX_X64: "linux-x64",
      MACOS_ARM64: "macos-arm64",
      MACOS_X64: "macos-x64",
    })) {
      const hash = checksumFor(checksums, `mise-${version}-${platform}`);
      updated = replaceOnce(
        updated,
        new RegExp(`^([ \\t]*${runner}_SHA256:[ \\t]*)[^\\s]+`, "gm"),
        (match) => `${match[1]}${hash}`,
        `${runner} mise checksum binding`,
      );
    }
    return updated;
  });
  yield* writeIfChanged(path, updated);
});

const urlString = Schema.String.check(
  Schema.makeFilter<string>((value) => URL.canParse(value)),
);
const browserConfig = Schema.Struct({
  extensions: Schema.Struct({
    crx: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        version: Schema.String,
        url: urlString,
        sha256: Schema.String,
      }),
    ),
  }),
});

export const updateBrowser = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(root, "home/applications/helium/config.toml");
  const content = yield* fs.readFileString(path);
  const config = yield* Schema.decodeUnknownEffect(browserConfig)(
    yield* transform(() => Bun.TOML.parse(content)),
  );
  const pins = config.extensions.crx.filter((entry) => entry.id === twpExtensionId);
  const [pin] = pins;
  if (pins.length !== 1 || !pin)
    return yield* Effect.fail(new DotfilesError("Expected one browser TWP CRX pin"));
  const version = pin.version;
  // Retain the pinned Chromium variant rather than switching MV2/MV3 assets
  const variant = (yield* transform(() => new URL(pin.url))).pathname.match(
    /\/TWP_[^/]+?_(Chromium[^/]*)\.crx$/,
  )?.[1];
  if (!variant)
    return yield* Effect.fail(
      new DotfilesError("Unsupported browser TWP CRX asset name"),
    );
  const release = yield* releaseAt(twpRepository, `v${version}`);
  const assets = release.assets.filter(
    (asset) => asset.name === `TWP_${version}_${variant}.crx`,
  );
  const [asset] = assets;
  if (assets.length !== 1 || !asset)
    return yield* Effect.fail(
      new DotfilesError(`Expected one ${variant} CRX asset for TWP ${version}`),
    );
  const url = asset.browser_download_url;
  const bytes = yield* releaseAsset(twpRepository, `v${version}`, asset.name);
  const hash = `sha256-${new Bun.CryptoHasher("sha256").update(bytes).digest("base64")}`;
  // Parse each table through Schema before applying the textual, comment-preserving rewrite
  const pattern = /^\[\[extensions\.crx\]\][^\r\n]*\r?\n(?:(?!^\[)[\s\S])*/gm;
  let updated = content;
  let found = false;
  for (const match of content.matchAll(pattern)) {
    const block = match[0];
    const entry = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        extensions: Schema.Struct({
          crx: Schema.Array(Schema.Struct({ id: Schema.String })),
        }),
      }),
    )(yield* transform(() => Bun.TOML.parse(block)));
    if (entry.extensions.crx[0]?.id !== pin.id) continue;
    found = true;
    const replacement = yield* transform(() => {
      let replacement = block;
      for (const [key, value] of Object.entries({ url, sha256: hash })) {
        replacement = replaceOnce(
          replacement,
          new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*")[^"\\r\\n]*(")`, "gm"),
          (match) => `${match[1]}${value}${match[2]}`,
          `browser TWP ${key} binding`,
        );
      }
      return replacement;
    });
    updated = updated.replace(block, () => replacement);
  }
  if (!found)
    return yield* Effect.fail(new DotfilesError("Missing browser TWP CRX table"));
  yield* writeIfChanged(path, updated);
});
