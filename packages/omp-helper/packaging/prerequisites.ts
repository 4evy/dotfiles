import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command } from "./dependencies";
import {
  BUILD_TOOLS,
  type BuildPrerequisites,
  PACKAGE_FORMATS,
  type PackageFormat,
} from "./targets";

function osRelease(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/u);
    if (match?.[1] && match[2] !== undefined)
      result[match[1]] = match[2].replace(/^(["'])(.*)\1$/u, "$2");
  }
  return result;
}

export async function buildPrerequisites(
  format: PackageFormat,
  outputDirectory: string,
  release: string | undefined,
): Promise<BuildPrerequisites> {
  const darwin = format === "darwin";
  const architecture = process.arch;
  if (
    process.platform !== (darwin ? "darwin" : "linux") ||
    (architecture !== "x64" && architecture !== "arm64")
  )
    throw new Error(
      darwin
        ? "Build Darwin payloads on macOS x86_64 or arm64"
        : "Build on Linux x86_64 or aarch64, on the target distro",
    );
  if (!release || !/^[1-9][0-9]*$/u.test(release))
    throw new Error("--release must be a positive integer");
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (!epoch || !/^[0-9]+$/u.test(epoch) || !Number.isSafeInteger(Number(epoch)))
    throw new Error("Set SOURCE_DATE_EPOCH to the source revision's Unix timestamp");
  const mtime = new Date(Number(epoch) * 1000).toISOString();
  const helper = resolve(import.meta.dir, "..");
  const repo = resolve(helper, "../..");
  const metadata = await Bun.file(join(helper, "package.json")).json();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(metadata.version))
    throw new Error("Native packages require a numeric major.minor.patch version");
  if (metadata.packageManager !== `bun@${Bun.version}`)
    throw new Error(`Use ${metadata.packageManager}; running bun@${Bun.version}`);
  const manifest = await Bun.file(join(helper, "manifest.json")).json();
  if (manifest.version !== metadata.version)
    throw new Error("package.json and manifest.json versions differ");
  const source = await Bun.file(join(import.meta.dir, "source.json")).json();
  const upstream = await Bun.file(join(repo, "packages/omp/source.json")).json();
  if (source.version !== upstream.version || source.url !== upstream.url)
    throw new Error(
      "Update packaging/source.json's archive checksum for the current OMP source pin",
    );
  const distro: Record<string, string> = darwin
    ? { ID: "macos", VERSION_ID: command(["sw_vers", "-productVersion"], repo) }
    : osRelease(await readFile("/etc/os-release", "utf8"));
  const family = `${distro.ID ?? ""} ${distro.ID_LIKE ?? ""}`.split(/\s+/u);
  const suse = family.some((id) => /^(?:suse|sles|sled|opensuse(?:-.+)?)$/u.test(id));
  const supported = [
    ...(format === "darwin" ? [] : PACKAGE_FORMATS[format].families),
    ...(format === "rpm" && suse ? family : []),
  ];
  if (!darwin && !family.some((id) => supported.includes(id)))
    throw new Error(
      `${format} metadata does not support this build distro (${distro.ID})`,
    );
  if (!darwin) command(["getconf", "GNU_LIBC_VERSION"], repo);
  for (const tool of BUILD_TOOLS[darwin ? "darwin" : "linux"]) {
    const path = Bun.which(tool);
    if (!path) throw new Error(`Missing build prerequisite: ${tool}`);
    if ((await realpath(path)).startsWith("/nix/"))
      throw new Error(`Use the native distro toolchain, not ${tool} from Nix`);
  }
  const bunPath = await realpath(process.execPath);
  if (bunPath.startsWith("/nix/"))
    throw new Error("Use a standalone upstream Bun binary, not a Nix Bun wrapper");
  const toolchain = {
    bun: Bun.version,
    ...(!darwin
      ? {
          rustc: command(["rustc", "--version"], repo),
          cargo: command(["cargo", "--version"], repo),
          nfpm: command(["nfpm", "--version"], repo),
        }
      : {}),
  };
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  return {
    helper,
    repo,
    bunPath,
    output,
    epoch,
    mtime,
    version: metadata.version,
    release,
    architecture,
    suse,
    distro,
    toolchain,
    source,
    manifest,
    ...(format === "darwin"
      ? { darwin: true as const, format }
      : { darwin: false as const, format }),
  };
}
