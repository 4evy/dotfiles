import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { command } from "./command";
import {
  type Generation,
  type Manager,
  manifestSchema,
  nativePath,
  type PackageIdentity,
  packageIdentitySchema,
  storePath,
} from "./schemas";

const packageIdentityPartsSchema = z.tuple([z.string(), z.string()]);
type NativeManager = Exclude<Manager, "nix">;
interface NativePackagePolicy {
  executable: string;
  files: string[];
  owner(manifest: string): string[];
  owns(output: string): boolean;
  installed?: string[];
  identity(path: string): string[];
  parseIdentity(output: string): PackageIdentity;
}

const NATIVE_PACKAGES = {
  dpkg: {
    executable: "dpkg-query",
    files: ["dpkg-query", "--listfiles", "omp-helper"],
    owner: (manifest) => ["dpkg-query", "--search", manifest],
    owns: (output) =>
      output
        .trim()
        .split("\n")
        .every((line) => /^omp-helper(?::[a-z0-9-]+)?: /u.test(line)),
    installed: [
      "dpkg-query",
      "--show",
      `--showformat=\${db:Status-Status}`,
      "omp-helper",
    ],
    identity: () => [
      "dpkg-query",
      "--show",
      `--showformat=\${Version}\n\${Architecture}\n`,
      "omp-helper",
    ],
    parseIdentity: parsePackageIdentity,
  },
  rpm: {
    executable: "rpm",
    files: ["rpm", "-ql", "omp-helper"],
    owner: (manifest) => ["rpm", "-qf", "--queryformat", "%{NAME}\n", manifest],
    owns: (output) => output.trim() === "omp-helper",
    identity: (path) => [
      "rpm",
      "-qf",
      "--queryformat",
      "%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n%{ARCH}\n",
      join(path, "share/omp-helper/manifest.json"),
    ],
    parseIdentity: parsePackageIdentity,
  },
  pacman: {
    executable: "pacman",
    files: ["pacman", "-Qlq", "omp-helper"],
    owner: (manifest) => ["pacman", "-Qqo", manifest],
    owns: (output) => output.trim() === "omp-helper",
    identity: () => ["env", "LC_ALL=C", "pacman", "-Qi", "omp-helper"],
    parseIdentity: (output) =>
      packageIdentitySchema.parse({
        version: output.match(/^Version[ \t]*:[ \t]*(\S+)[ \t]*$/mu)?.[1],
        architecture: output.match(/^Architecture[ \t]*:[ \t]*(\S+)[ \t]*$/mu)?.[1],
      }),
  },
} satisfies { [manager in NativeManager]: NativePackagePolicy };
function parsePackageIdentity(output: string): PackageIdentity {
  const [version, architecture] = packageIdentityPartsSchema.parse(
    output.trim().split("\n"),
  );
  return packageIdentitySchema.parse({ version, architecture });
}

async function nativePackageIdentity(
  manager: NativeManager,
  path: string,
): Promise<PackageIdentity> {
  const policy = NATIVE_PACKAGES[manager];
  return policy.parseIdentity((await command(policy.identity(path))).stdout);
}

async function ownsNativePackage(
  policy: NativePackagePolicy,
  manifest: string,
): Promise<boolean> {
  if (!Bun.which(policy.executable)) return false;
  const owner = await command(policy.owner(manifest), true);
  if (owner.code !== 0 || !policy.owns(owner.stdout)) return false;
  if (!policy.installed) return true;
  const installed = await command(policy.installed, true);
  return installed.code === 0 && installed.stdout === "installed";
}

async function nativeOwnership(path: string) {
  nativePath.parse(path);
  const root = dirname(path);
  const ancestors = root === "/usr/lib/omp-helper" ? ["/usr", "/usr/lib"] : ["/opt"];
  for (const directory of ["/", ...ancestors, root, path]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error(
        `Native package directory is not root-owned and protected: ${directory}`,
      );
    }
  }
  const manifest = join(path, "share/omp-helper/manifest.json");
  const owners: NativeManager[] = [];
  for (const manager of Object.keys(NATIVE_PACKAGES) as NativeManager[]) {
    if (await ownsNativePackage(NATIVE_PACKAGES[manager], manifest))
      owners.push(manager);
  }
  const manager = owners[0];
  if (owners.length !== 1 || !manager)
    throw new Error(
      "Native payload must belong to exactly one installed omp-helper package",
    );
  const argv = NATIVE_PACKAGES[manager].files;
  const files = new Set(
    (await command(argv)).stdout
      .trim()
      .split("\n")
      .map((file) => file.replace(/\/$/u, "")),
  );
  if (!files.has(path) || !files.has(root))
    throw new Error("Native package does not own its payload directories");
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const info = await lstat(file);
      if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0)) {
        throw new Error(`Native payload is writable by a non-root user: ${file}`);
      }
      if (!files.has(file))
        throw new Error(
          `Selected native payload contains a file not owned by omp-helper: ${file}`,
        );
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (!target.startsWith(`${path}/`))
          throw new Error(`Native payload symlink escapes its package: ${file}`);
      } else if (info.isDirectory()) await inspect(file);
      else if (!info.isFile())
        throw new Error(`Native payload contains a special file: ${file}`);
    }
  }
  await inspect(path);
  return { manager, packageIdentity: await nativePackageIdentity(manager, path) };
}

export async function artifact(path: string) {
  const ownership = storePath.safeParse(path).success
    ? { manager: "nix" as const }
    : await nativeOwnership(path);
  if ((await realpath(path)) !== path)
    throw new Error(
      "packagePath must identify an installed package payload, not an alias",
    );
  if (ownership.manager === "nix")
    await command(["nix-store", "--query", "--hash", path]);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(path, "share/omp-helper/manifest.json"), "utf8")),
  );
  if (ownership.manager !== "nix" && basename(path) !== manifest.version)
    throw new Error("Native payload version disagrees with its manifest");
  for (const executable of ["omp-helper", "omp-helper-desktop"]) {
    const info = await lstat(join(path, "bin", executable));
    if ((!info.isFile() && !info.isSymbolicLink()) || (info.mode & 0o111) === 0) {
      throw new Error(`Artifact lacks executable ${executable}`);
    }
  }
  return { ...manifest, ...ownership };
}

export async function packageOwnership(generation: Generation) {
  try {
    const checked = await artifact(generation.packagePath);
    if (
      checked.manager !== generation.manager ||
      checked.version !== generation.version
    ) {
      throw new Error("Recorded generation no longer matches its package");
    }
    if (
      generation.manager !== "nix" &&
      checked.manager !== "nix" &&
      (generation.packageIdentity.version !== checked.packageIdentity.version ||
        generation.packageIdentity.architecture !==
          checked.packageIdentity.architecture)
    ) {
      throw new Error(
        "Installed native package version/release or architecture differs from the recorded package identity",
      );
    }
    return {
      manager: generation.manager,
      owned: true as const,
      ...(generation.manager !== "nix"
        ? { packageIdentity: generation.packageIdentity }
        : {}),
    };
  } catch (error) {
    return {
      manager: generation.manager,
      owned: false as const,
      ...(generation.manager !== "nix"
        ? { packageIdentity: generation.packageIdentity }
        : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
