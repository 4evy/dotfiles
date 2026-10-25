import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { writeIfChanged } from "../../lib/typescript/files.ts";
import { download, root } from "./process.ts";

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

export async function updateBunBootstrap() {
  const path = join(root, "tools/setup/setup.sh");
  const content = await Bun.file(path).text();
  const version = content.match(/releases\/download\/bun-v([^/]+)\//)?.[1];
  if (!version) throw new Error("Missing Bun bootstrap version");
  const checksums = parseChecksums(
    await (
      await download(
        `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`,
      )
    ).text(),
  );
  let count = 0;
  const updated = content.replace(
    /(^[ \t]*archive=([^\s]+)\r?\n[ \t]*expected=)[^\s]+/gm,
    (_, prefix: string, archive: string) => {
      count++;
      return `${prefix}${checksumFor(checksums, `${archive}.zip`)}`;
    },
  );
  if (!count || count !== [...content.matchAll(/^[ \t]*archive=/gm)].length)
    throw new Error("Missing Bun bootstrap checksum bindings");
  writeIfChanged(path, updated, (await stat(path)).mode & 0o777);
}

export async function updateMise() {
  const path = join(root, ".github/actions/setup-check-tools/action.yaml");
  const content = await Bun.file(path).text();
  const action = v.parse(
    v.object({
      runs: v.object({
        steps: v.array(
          v.object({
            env: v.optional(v.record(v.string(), v.unknown())),
          }),
        ),
      }),
    }),
    Bun.YAML.parse(content),
  );
  const installers = action.runs.steps.filter(
    (step) => step.env?.MISE_VERSION !== undefined,
  );
  const [installer] = installers;
  if (installers.length !== 1) throw new Error("Expected one mise install step");
  const version = installer?.env?.MISE_VERSION;
  if (typeof version !== "string" || !/^v\S+$/.test(version))
    throw new Error("Missing mise bootstrap version");
  const checksums = parseChecksums(
    await (
      await download(
        `https://github.com/jdx/mise/releases/download/${version}/SHASUMS256.txt`,
      )
    ).text(),
  );
  const platforms = {
    LINUX_X64: "linux-x64",
    MACOS_ARM64: "macos-arm64",
    MACOS_X64: "macos-x64",
  };
  let updated = content;
  for (const [runner, platform] of Object.entries(platforms)) {
    const hash = checksumFor(checksums, `mise-${version}-${platform}`);
    updated = replaceOnce(
      updated,
      new RegExp(`^([ \\t]*${runner}_SHA256:[ \\t]*)[^\\s]+`, "gm"),
      (match) => `${match[1]}${hash}`,
      `${runner} mise checksum binding`,
    );
  }
  writeIfChanged(path, updated);
}

export async function updateBrowser() {
  const path = join(root, "home/applications/helium/config.toml");
  const content = await Bun.file(path).text();
  const config = v.parse(
    v.object({
      extensions: v.object({
        crx: v.array(
          v.object({
            id: v.string(),
            version: v.string(),
            url: v.pipe(v.string(), v.url()),
            sha256: v.string(),
          }),
        ),
      }),
    }),
    Bun.TOML.parse(content),
  );
  const pins = config.extensions.crx.filter(
    (entry) => entry.id === "bolggfoncklhniejomgplkjcllmnonbh",
  );
  const [pin] = pins;
  if (pins.length !== 1 || !pin) throw new Error("Expected one browser TWP CRX pin");
  const version = pin.version;
  // Retain the pinned Chromium variant rather than switching MV2/MV3 assets
  const variant = new URL(pin.url).pathname.match(
    /\/TWP_[^/]+?_(Chromium[^/]*)\.crx$/,
  )?.[1];
  if (!variant) throw new Error("Unsupported browser TWP CRX asset name");
  const release = v.parse(
    v.object({
      assets: v.array(
        v.object({
          name: v.string(),
          browser_download_url: v.pipe(v.string(), v.url()),
        }),
      ),
    }),
    await (
      await download(
        `https://api.github.com/repos/FilipePS/Traduzir-paginas-web/releases/tags/v${version}`,
      )
    ).json(),
  );
  const assets = release.assets.filter(
    (asset) => asset.name === `TWP_${version}_${variant}.crx`,
  );
  const [asset] = assets;
  if (assets.length !== 1 || !asset)
    throw new Error(`Expected one ${variant} CRX asset for TWP ${version}`);
  const url = asset.browser_download_url;
  const bytes = await (await download(url)).arrayBuffer();
  const hash = `sha256-${new Bun.CryptoHasher("sha256").update(bytes).digest("base64")}`;
  let found = false;
  const updated = content.replace(
    /^\[\[extensions\.crx\]\][^\r\n]*\r?\n(?:(?!^\[)[\s\S])*/gm,
    (block) => {
      const entry = v.parse(
        v.object({
          extensions: v.object({ crx: v.array(v.object({ id: v.string() })) }),
        }),
        Bun.TOML.parse(block),
      );
      if (entry.extensions.crx[0]?.id !== pin.id) return block;
      found = true;
      let updated = block;
      for (const [key, value] of Object.entries({ url, sha256: hash })) {
        updated = replaceOnce(
          updated,
          new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*")[^"\\r\\n]*(")`, "gm"),
          (match) => `${match[1]}${value}${match[2]}`,
          `browser TWP ${key} binding`,
        );
      }
      return updated;
    },
  );
  if (!found) throw new Error("Missing browser TWP CRX table");
  writeIfChanged(path, updated);
}

export async function updateChatgpt() {
  const path = join(root, "home/files/.local/share/nix/chatgpt/package.nix");
  const content = await Bun.file(path).text();
  const version = content.match(/^[ \t]+version = "([^"\s]+)";/m)?.[1];
  if (!version) throw new Error("Missing ChatGPT version");
  const url = `https://persistent.oaistatic.com/codex-app-prod/linux/rpm/x86_64/chatgpt-${version}-1.x86_64.rpm`;
  // Hash the requested release rather than silently selecting a different version
  const hash = `sha256-${new Bun.CryptoHasher("sha256").update(await (await download(url)).arrayBuffer()).digest("base64")}`;
  let updated = content;
  for (const [key, value] of Object.entries({ url, hash })) {
    updated = replaceOnce(
      updated,
      new RegExp(`^([ \\t]+${key} = ")[^"\\r\\n]+(";)$`, "gm"),
      (match) => `${match[1]}${value}${match[2]}`,
      `ChatGPT source ${key} binding`,
    );
  }
  writeIfChanged(path, updated);
}
