import { randomUUID } from "node:crypto";
import { ptree } from "@oh-my-pi/pi-utils";
import { remoteArgv } from "../connections/command";
import type { Connection } from "../connections/types";

export const MANAGERS = [
  "apt",
  "dnf",
  "yum",
  "pacman",
  "zypper",
  "apk",
  "nix",
  "brew",
] as const;
export type Manager = (typeof MANAGERS)[number];
export type SupportedManager = Exclude<Manager, "apk">;

export type Platform = {
  os: string;
  arch: string;
  distribution: string;
  immutable: boolean;
  available: Manager[];
  recommended: Manager | null;
  systemdUser: boolean;
};

const DISTRIBUTION_MANAGERS: Readonly<Record<string, Manager>> = {
  debian: "apt",
  ubuntu: "apt",
  linuxmint: "apt",
  pop: "apt",
  fedora: "dnf",
  rhel: "dnf",
  centos: "dnf",
  rocky: "dnf",
  almalinux: "dnf",
  arch: "pacman",
  manjaro: "pacman",
  endeavouros: "pacman",
  opensuse: "zypper",
  "opensuse-tumbleweed": "zypper",
  "opensuse-leap": "zypper",
  sles: "zypper",
  nixos: "nix",
};

function recommendManager(
  os: string,
  distribution: string,
  immutable: boolean,
  available: readonly Manager[],
): Manager | null {
  if (os === "Darwin") return available.includes("brew") ? "brew" : null;
  if (os !== "Linux") return null;
  if (immutable) return available.includes("nix") ? "nix" : null;
  const native = DISTRIBUTION_MANAGERS[distribution];
  if (native && available.includes(native)) return native;
  return available.find((manager) => manager !== "apk") ?? null;
}

export async function remoteCommand(
  connection: Connection,
  script: string,
  signal?: AbortSignal,
  timeout = 30_000,
) {
  const args = await remoteArgv(connection, script, false);
  const result = await ptree.exec(["ssh", ...args], {
    timeout,
    ...(signal ? { signal } : {}),
    allowNonZero: true,
    allowAbort: true,
  });
  signal?.throwIfAborted();
  if (!result.ok || result.exitCode !== 0) {
    throw new Error(
      `Helper command failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/** Probe over plain SSH so discovery also works before the helper exists */
export async function inspectPlatform(
  connection: Connection,
  signal?: AbortSignal,
): Promise<Platform> {
  const marker = `OMP_HELPER_${randomUUID().replaceAll("-", "")}`;
  const output = await remoteCommand(
    connection,
    `
os=$(uname -s) || exit
arch=$(uname -m) || exit
distribution=unknown
if [ -r /etc/os-release ]; then
  while IFS= read -r line; do
    case "$line" in ID=*) distribution=\${line#ID=}; distribution=\${distribution#\\"}; distribution=\${distribution%\\"} ;; esac
  done < /etc/os-release
fi
if [ "$os" = Darwin ]; then distribution=macos; fi
immutable=no
if [ -e /run/ostree-booted ] || [ -d /usr/lib/bootc ] || [ -e /etc/NIXOS ] || [ -x /usr/sbin/transactional-update ] || command -v transactional-update >/dev/null 2>&1; then immutable=yes; fi
available=
for manager in ${MANAGERS.join(" ")}; do
  executable=$manager
  [ "$manager" != apt ] || executable=apt-get
  if [ "$manager" = brew ] && ! command -v brew >/dev/null 2>&1; then
    if [ -x /opt/homebrew/bin/brew ]; then available="$available brew";
    elif [ -x /usr/local/bin/brew ]; then available="$available brew"; fi
    continue
  fi
  if command -v "$executable" >/dev/null 2>&1; then available="$available $manager"; fi
done
systemd=no
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then systemd=yes; fi
printf '\\0${marker}\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0${marker}\\0' "$os" "$arch" "$distribution" "$immutable" "$available" "$systemd"
`,
    signal,
  );
  const frame = `\0${marker}\0`;
  const start = output.indexOf(frame);
  const end = output.indexOf(frame, start + frame.length);
  if (start < 0 || end < 0) throw new Error("Incomplete helper platform probe");
  const fields = output.slice(start + frame.length, end).split("\0");
  const [os, arch, distribution, immutable, managers, systemd] = fields;
  if (
    fields.length !== 6 ||
    !os ||
    !arch ||
    !distribution ||
    managers === undefined ||
    !["yes", "no"].includes(immutable ?? "") ||
    !["yes", "no"].includes(systemd ?? "")
  ) {
    throw new Error("Invalid helper platform probe");
  }
  const available = MANAGERS.filter((manager) =>
    managers.split(/\s+/u).includes(manager),
  );
  const recommended = recommendManager(
    os,
    distribution,
    immutable === "yes",
    available,
  );
  return {
    os,
    arch,
    distribution,
    immutable: immutable === "yes",
    available,
    recommended,
    systemdUser: systemd === "yes",
  };
}

export function selectManager(
  platform: Platform,
  requested?: Manager,
): SupportedManager {
  if (platform.os !== "Linux" && platform.os !== "Darwin")
    throw new Error("omp-helper supports Linux and macOS jobs");
  const manager = requested ?? platform.recommended;
  if (!manager || !platform.available.includes(manager))
    throw new Error(
      "No supported package manager is available; install one explicitly before deploying omp-helper",
    );
  if (platform.os === "Darwin" && manager !== "brew")
    throw new Error("macOS managed jobs require the Homebrew jobs-only payload");
  if (platform.os === "Linux" && manager === "brew")
    throw new Error("Linux managed jobs require a distro-native package or Nix");
  if (manager === "apk")
    throw new Error(
      "apk detected, but no musl-compatible omp-helper package is provided; do not install glibc artifacts on Alpine",
    );
  if (platform.immutable && manager !== "nix")
    throw new Error(
      "Immutable host: native host-package mutation is disabled; use existing Nix or explicitly manage the OS image outside this tool",
    );
  return manager;
}
