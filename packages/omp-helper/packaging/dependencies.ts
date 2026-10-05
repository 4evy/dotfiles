import { realpath } from "node:fs/promises";

export type Format = "deb" | "rpm" | "pacman";

export function command(args: string[], cwd: string, env = process.env): string {
  const result = Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${result.exitCode}):\n${result.stderr.toString()}${result.stdout.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

// Include plugins and dlopen libraries that an ELF dependency scan cannot see
const runtimePackages: Record<Format | "suse", string[][]> = {
  deb: [
    ["libc6"],
    ["libstdc++6"],
    ["libgcc-s1"],
    ["libglib2.0-0t64", "libglib2.0-0"],
    ["libgstreamer1.0-0"],
    ["libgstreamer-plugins-base1.0-0"],
    ["gstreamer1.0-plugins-base"],
    ["gstreamer1.0-plugins-good"],
    ["gstreamer1.0-pipewire"],
    ["libpipewire-0.3-0t64", "libpipewire-0.3-0"],
    ["libwayland-client0"],
    ["libxkbcommon0"],
    ["xkb-data"],
    ["libasound2t64", "libasound2"],
    ["libudev1"],
    ["systemd"],
    ["dbus"],
    ["dbus-daemon", "dbus"],
    ["util-linux"],
    ["xdg-desktop-portal"],
    ["ca-certificates"],
  ],
  rpm: [
    ["glibc"],
    ["libstdc++"],
    ["libgcc"],
    ["glib2"],
    ["gstreamer1"],
    ["gstreamer1-plugins-base"],
    ["gstreamer1-plugins-good"],
    ["pipewire-gstreamer"],
    ["pipewire-libs"],
    ["libwayland-client"],
    ["libxkbcommon"],
    ["xkeyboard-config"],
    ["alsa-lib"],
    ["systemd-libs"],
    ["systemd"],
    ["dbus"],
    ["dbus-daemon", "dbus"],
    ["util-linux-core", "util-linux"],
    ["xdg-desktop-portal"],
    ["ca-certificates"],
  ],
  suse: [
    ["glibc"],
    ["libstdc++6"],
    ["libgcc_s1"],
    ["libglib-2_0-0"],
    ["libgstreamer-1_0-0"],
    ["libgstapp-1_0-0"],
    ["libgstvideo-1_0-0"],
    ["gstreamer-plugins-base"],
    ["gstreamer-plugins-good"],
    ["gstreamer-plugin-pipewire"],
    ["libpipewire-0_3-0"],
    ["pipewire"],
    ["libwayland-client0"],
    ["libxkbcommon0"],
    ["xkeyboard-config"],
    ["libasound2"],
    ["libudev1"],
    ["systemd"],
    ["dbus"],
    ["util-linux"],
    ["xdg-desktop-portal"],
    ["ca-certificates"],
  ],
  pacman: [
    ["glibc"],
    ["gcc-libs"],
    ["glib2"],
    ["gstreamer"],
    ["gst-plugins-base"],
    ["gst-plugins-good"],
    ["gst-plugin-pipewire"],
    ["pipewire"],
    ["wayland"],
    ["libxkbcommon"],
    ["xkeyboard-config"],
    ["alsa-lib"],
    ["systemd-libs"],
    ["systemd"],
    ["dbus"],
    ["util-linux"],
    ["xdg-desktop-portal"],
    ["ca-certificates"],
  ],
};

interface PackageQuery {
  version(name: string): string[];
  parseVersion(output: string, name: string): string;
  owner(path: string): string[];
  parseOwner(output: string): string | undefined;
  constraint(name: string, version: string): string;
}

const PACKAGE_QUERIES = {
  deb: {
    version: (name) => [
      "dpkg-query",
      "-W",
      `-f=\${db:Status-Status} \${Version}`,
      name,
    ],
    parseVersion: (output, name) => {
      if (!output.startsWith("installed ")) throw new Error(`${name} is not installed`);
      return output.slice("installed ".length);
    },
    owner: (path) => ["dpkg-query", "-S", path],
    parseOwner: (output) => {
      const owner = output.split(": ")[0];
      if (!owner || owner.includes("\n") || owner.includes(",")) return undefined;
      return owner.replace(/:(amd64|arm64)$/u, "");
    },
    constraint: (name, version) => `${name} (>= ${version})`,
  },
  rpm: {
    version: (name) => ["rpm", "-q", "--qf", "%{EPOCHNUM}:%{VERSION}-%{RELEASE}", name],
    parseVersion: (output) => output,
    owner: (path) => ["rpm", "-qf", "--qf", "%{NAME}", path],
    parseOwner: (output) => output,
    constraint: (name, version) => `${name} >= ${version}`,
  },
  pacman: {
    version: (name) => ["pacman", "-Q", name],
    parseVersion: (output, name) => {
      const version = output.split(/\s+/u)[1];
      if (!version) throw new Error(`pacman returned no installed version for ${name}`);
      return version;
    },
    owner: (path) => ["pacman", "-Qoq", path],
    parseOwner: (output) => output,
    constraint: (name, version) => `${name}>=${version}`,
  },
} satisfies Record<Format, PackageQuery>;

function installedVersion(format: Format, name: string, cwd: string): string {
  const policy: PackageQuery = PACKAGE_QUERIES[format];
  return policy.parseVersion(command(policy.version(name), cwd), name);
}

async function libraryOwner(
  format: Format,
  path: string,
  cwd: string,
): Promise<string> {
  const canonical = await realpath(path);
  if (canonical.startsWith("/nix/"))
    throw new Error(`Native packages cannot depend on Nix: ${path}`);
  const candidates = new Set([path, canonical]);
  for (const value of [...candidates]) {
    if (value.startsWith("/usr/")) candidates.add(value.slice(4));
    else candidates.add(`/usr${value}`);
  }
  for (const candidate of candidates) {
    try {
      const policy = PACKAGE_QUERIES[format];
      const owner = policy.parseOwner(command(policy.owner(candidate), cwd));
      if (owner !== undefined) return owner;
    } catch {
      // Merged-/usr systems may register the other spelling of this path
    }
  }
  throw new Error(`No distro package owns runtime library ${path}`);
}

export async function dependencies(
  format: Format,
  binaries: string[],
  payload: string,
  profile: Format | "suse" = format,
): Promise<string[]> {
  const packages = new Map<string, string>();
  for (const alternatives of runtimePackages[profile]) {
    let found = false;
    for (const name of alternatives) {
      try {
        packages.set(name, installedVersion(format, name, payload));
        found = true;
        break;
      } catch {
        // Debian transitions rename libraries without changing their SONAME
      }
    }
    if (!found)
      throw new Error(
        `Install a runtime prerequisite before building: ${alternatives.join(" or ")}`,
      );
  }
  for (const binary of binaries) {
    const metadata = command(
      ["readelf", "--program-headers", "--dynamic", binary],
      payload,
    );
    if (metadata.includes("/nix/"))
      throw new Error(`Nix-linked binary cannot be packaged: ${binary}`);
    const result = Bun.spawnSync(["ldd", binary], {
      cwd: payload,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    if (/not found/u.test(output))
      throw new Error(`Missing native runtime libraries for ${binary}:\n${output}`);
    if (
      result.exitCode !== 0 &&
      !/statically linked|not a dynamic executable/u.test(output)
    ) {
      throw new Error(`Cannot inspect ${binary}:\n${output}`);
    }
    for (const line of output.split("\n")) {
      const path = line.match(/(?:=>\s+|^\s*)(\/\S+)\s+\(/u)?.[1];
      if (!path || path.startsWith(`${payload}/`)) continue;
      const name = await libraryOwner(format, path, payload);
      packages.set(name, installedVersion(format, name, payload));
    }
  }
  return [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => PACKAGE_QUERIES[format].constraint(name, version));
}
