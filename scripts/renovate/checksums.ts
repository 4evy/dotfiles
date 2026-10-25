import { join } from "node:path";
import * as v from "valibot";
import { download, root } from "./process.ts";

export async function updateBunBootstrap() {
  const path = join(root, "scripts/setup/setup.sh");
  const content = await Bun.file(path).text();
  const version = content.match(/releases\/download\/bun-v([^/]+)\//)?.[1];
  if (!version) throw new Error("Missing Bun bootstrap version");
  const checksums = await (
    await download(
      `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`,
    )
  ).text();
  const updated = content.replace(
    /archive=([^\s]+)\n(\s+)expected=[a-f0-9]{64}/g,
    (_, archive: string, indent: string) => {
      const hash = checksums
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find(
          ([, name]) => name?.replace(/^\*?(?:\.\/)?/, "") === `${archive}.zip`,
        )?.[0];
      if (!hash || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error(`Missing checksum for ${archive}`);
      return `archive=${archive}\n${indent}expected=${hash}`;
    },
  );
  if (updated !== content) await Bun.write(path, updated);
}

export async function updateMise() {
  const path = join(root, ".github/actions/setup-check-tools/action.yaml");
  const content = await Bun.file(path).text();
  const version = content.match(/version: (v[\d.]+)/)?.[1];
  if (!version) throw new Error("Missing mise bootstrap version");
  const checksums = await (
    await download(
      `https://github.com/jdx/mise/releases/download/${version}/SHASUMS256.txt`,
    )
  ).text();
  const updated = content.replace(
    /(LINUX_X64|MACOS_ARM64|MACOS_X64)_SHA256: [a-f0-9]{64}/g,
    (_, runner: "LINUX_X64" | "MACOS_ARM64" | "MACOS_X64") => {
      const platform = {
        LINUX_X64: "linux-x64",
        MACOS_ARM64: "macos-arm64",
        MACOS_X64: "macos-x64",
      }[runner];
      const asset = `mise-${version}-${platform}`;
      const hash = checksums
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find(([, name]) => name?.replace(/^\*?(?:\.\/)?/, "") === asset)?.[0];
      if (!hash || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error(`Missing checksum for ${asset}`);
      return `${runner}_SHA256: ${hash}`;
    },
  );
  if (updated !== content) await Bun.write(path, updated);
}

export async function updateBrowser() {
  const path = join(root, "browser/helium.toml");
  const content = await Bun.file(path).text();
  const match = content.match(
    /version = "([^"\s]+)"\s+url = "([^"\s]+)"\s+sha256 = "([^"\s]+)"/,
  );
  if (!match?.[1] || !match[2] || !match[3]) throw new Error("Missing browser CRX pin");
  const version = match[1];
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
    (asset) =>
      asset.name.startsWith(`TWP_${version}_Chromium`) && asset.name.endsWith(".crx"),
  );
  const [asset] = assets;
  if (assets.length !== 1 || !asset)
    throw new Error(`Expected one Chromium CRX asset for TWP ${version}`);
  const url = asset.browser_download_url;
  const bytes = await (await download(url)).arrayBuffer();
  const hash = `sha256-${new Bun.CryptoHasher("sha256").update(bytes).digest("base64")}`;
  const updated = content.replace(
    match[0],
    `version = "${version}"\nurl = "${url}"\nsha256 = "${hash}"`,
  );
  if (updated !== content) await Bun.write(path, updated);
}

export async function updateChatgpt() {
  const path = join(root, "dotfiles/home/.local/share/nix/chatgpt/package.nix");
  const content = await Bun.file(path).text();
  const version = content.match(/^ {2}version = "([^"\s]+)";/m)?.[1];
  if (!version) throw new Error("Missing ChatGPT version");
  const url = `https://persistent.oaistatic.com/codex-app-prod/linux/rpm/x86_64/chatgpt-${version}-1.x86_64.rpm`;
  // Hash the requested release rather than silently selecting a different version
  const hash = `sha256-${new Bun.CryptoHasher("sha256").update(await (await download(url)).arrayBuffer()).digest("base64")}`;
  const updated = content
    .replace(/^ {4}url = "[^"\n]+";/m, `    url = "${url}";`)
    .replace(/^ {4}hash = "[^"\n]+";/m, `    hash = "${hash}";`);
  if (updated !== content) await Bun.write(path, updated);
}
