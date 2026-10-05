import { lstat, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { files, reportArtifact, run } from "./common";
import { dependencies } from "./dependencies";
import { type BuildContext, LINUX_ARCHITECTURES, PACKAGE_FORMATS } from "./targets";

interface PackageFileInfo {
  mode: number;
  mtime: string;
  owner: "root";
  group: "root";
}

type PackageContent =
  | { dst: string; type: "dir"; file_info: PackageFileInfo }
  | { src: string; dst: string; type: "symlink"; file_info: PackageFileInfo }
  | { src: string; dst: string; file_info: PackageFileInfo };

function packageFileInfo(mode: number, mtime: string): PackageFileInfo {
  return { mode, mtime, owner: "root", group: "root" };
}

async function packageContents(
  payload: string,
  installPath: string,
  mtime: string,
): Promise<PackageContent[]> {
  const directoryInfo = packageFileInfo(0o755, mtime);
  const contents: PackageContent[] = [
    { dst: dirname(installPath), type: "dir", file_info: directoryInfo },
    { dst: installPath, type: "dir", file_info: directoryInfo },
  ];
  for await (const path of files(payload)) {
    const info = await lstat(path);
    const dst = join(installPath, relative(payload, path));
    const fileInfo = packageFileInfo(
      info.isDirectory() || (info.mode & 0o111) !== 0 ? 0o755 : 0o644,
      mtime,
    );
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      const resolved = resolve(dirname(path), link);
      if (
        isAbsolute(link) ||
        !resolved.startsWith(`${payload}/`) ||
        !(await realpath(path)).startsWith(`${payload}/`)
      )
        throw new Error(`Payload symlink escapes package: ${path} -> ${link}`);
      contents.push({
        src: link,
        dst,
        type: "symlink",
        file_info: { ...fileInfo, mode: 0o777 },
      });
    } else if (info.isDirectory())
      contents.push({ dst, type: "dir", file_info: fileInfo });
    else if (info.isFile()) contents.push({ src: path, dst, file_info: fileInfo });
    else throw new Error(`Unexpected payload file type: ${path}`);
  }
  for (const name of ["omp-helper", "omp-runtime"]) {
    contents.push({
      src: `${installPath}/bin/${name}`,
      dst: `/usr/bin/${name}`,
      type: "symlink",
      file_info: packageFileInfo(0o777, mtime),
    });
  }
  contents.push({
    src: `${installPath}/bin/omp-runtime`,
    dst: "/usr/bin/omp",
    type: "symlink",
    file_info: packageFileInfo(0o777, mtime),
  });
  return contents;
}

export async function packageLinux(
  context: Extract<BuildContext, { darwin: false }>,
  nativePackage: string,
): Promise<void> {
  const {
    work,
    payload,
    installPath,
    output,
    epoch,
    mtime,
    version,
    release,
    architecture,
    format,
    suse,
    distro,
    toolchain,
    source,
  } = context;
  const binaries = [join(payload, "bin/bun"), join(payload, "bin/omp-helper-desktop")];
  for await (const path of files(nativePackage)) {
    if (!(await lstat(path)).isFile()) continue;
    const header = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer());
    if (
      header[0] === 0x7f &&
      header[1] === 0x45 &&
      header[2] === 0x4c &&
      header[3] === 0x46
    )
      binaries.push(path);
  }
  if (binaries.length === 2)
    throw new Error("The locked native addon package contains no ELF payload");
  const depends = await dependencies(
    format,
    binaries,
    payload,
    format === "rpm" && suse ? "suse" : format,
  );
  await writeFile(
    join(payload, "share/omp-helper/build.json"),
    `${JSON.stringify({ distro, architecture: process.arch, sourceDateEpoch: epoch, toolchain, runtimeSource: source, dependencies: depends }, null, 2)}\n`,
  );
  const contents = await packageContents(payload, installPath, mtime);
  const config = {
    name: "omp-helper",
    arch: LINUX_ARCHITECTURES[architecture].package,
    platform: "linux",
    version,
    release,
    maintainer: "4evy <git@evy.pink>",
    description: "Managed omp job gateway and Wayland desktop helper",
    homepage: "https://github.com/4evy/dotfiles",
    license: "MIT",
    mtime,
    depends,
    contents,
    disable_globbing: true,
    rpm: { buildhost: "omp-helper-builder" },
  };
  const configPath = join(work, "nfpm.json");
  await writeFile(configPath, JSON.stringify(config));
  const distroTag = `${distro.ID}-${distro.VERSION_ID ?? "rolling"}`.replace(
    /[^a-zA-Z0-9._-]/gu,
    "_",
  );
  const artifact = join(
    output,
    `omp-helper_${version}-${release}_${distroTag}_${process.arch}.${PACKAGE_FORMATS[format].extension}`,
  );
  await run(
    [
      "nfpm",
      "package",
      "--config",
      configPath,
      "--packager",
      PACKAGE_FORMATS[format].packager,
      "--target",
      artifact,
    ],
    work,
    { ...process.env, SOURCE_DATE_EPOCH: epoch },
  );
  await reportArtifact(artifact, context);
}
