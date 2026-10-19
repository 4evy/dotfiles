import { join } from "node:path";

const recipePath = join(
  import.meta.dir,
  "../../bluebuild/recipes/spectrum/stages/farstep.yml",
);
const recipe = await Bun.file(recipePath).text();

const toolchains = [
  {
    name: "BUN",
    manifest: (version: string) =>
      `https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`,
    asset: (_version: string) => "bun-linux-x64-baseline.zip",
  },
  {
    name: "RUST",
    manifest: (version: string) =>
      `https://static.rust-lang.org/dist/rust-${version}-x86_64-unknown-linux-gnu.tar.xz.sha256`,
    asset: (version: string) => `rust-${version}-x86_64-unknown-linux-gnu.tar.xz`,
  },
  {
    name: "NFPM",
    manifest: (version: string) =>
      `https://github.com/goreleaser/nfpm/releases/download/v${version}/checksums.txt`,
    asset: (version: string) => `nfpm_${version}_Linux_x86_64.tar.gz`,
  },
];

let updated = recipe;
for (const toolchain of toolchains) {
  const versionPin = new RegExp(
    `\\bARG ${toolchain.name}_VERSION=(\\d+\\.\\d+\\.\\d+)\\s`,
  );
  const digestPin = new RegExp(`\\bARG ${toolchain.name}_SHA256=([a-f0-9]{64})\\s`);
  const version = recipe.match(versionPin)?.[1];
  const digest = recipe.match(digestPin)?.[1];
  if (!version || !digest)
    throw new Error(`Missing ${toolchain.name} version or SHA-256 pin`);

  const url = toolchain.manifest(version);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  const asset = toolchain.asset(version);
  const checksum = (await response.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, filename]) => filename?.replace(/^\*/, "") === asset)?.[0];
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
    throw new Error(`Missing SHA-256 checksum for ${asset} in ${url}`);

  updated = updated.replace(
    `ARG ${toolchain.name}_SHA256=${digest}`,
    `ARG ${toolchain.name}_SHA256=${checksum}`,
  );
  console.log(`${toolchain.name} ${version}: checksum refreshed`);
}

// Write only after every release manifest has resolved successfully
if (updated !== recipe) await Bun.write(recipePath, updated);
