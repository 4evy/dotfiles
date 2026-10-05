import type { Format } from "./dependencies";
export const PACKAGE_FORMATS = {
  deb: { families: ["debian", "ubuntu"], extension: "deb", packager: "deb" },
  rpm: { families: ["fedora", "rhel", "centos"], extension: "rpm", packager: "rpm" },
  pacman: {
    families: ["arch", "manjaro"],
    extension: "pkg.tar.zst",
    packager: "archlinux",
  },
} satisfies Record<Format, { families: string[]; extension: string; packager: string }>;
export const BUILD_TOOLS = {
  darwin: ["gtar", "patch"],
  linux: [
    "cargo",
    "rustc",
    "nfpm",
    "tar",
    "patch",
    "pkg-config",
    "readelf",
    "ldd",
    "cc",
  ],
};
export const LINUX_ARCHITECTURES = {
  x64: { triple: "x86_64-unknown-linux-gnu", package: "amd64" },
  arm64: { triple: "aarch64-unknown-linux-gnu", package: "arm64" },
} as const;
type Architecture = keyof typeof LINUX_ARCHITECTURES;
export type PackageFormat = Format | "darwin";

interface BuildInputs {
  helper: string;
  repo: string;
  work: string;
  payload: string;
  root: string;
  target: string;
  runtime: string;
  installPath: string;
  bunPath: string;
  output: string;
  epoch: string;
  mtime: string;
  version: string;
  release: string;
  architecture: Architecture;
  suse: boolean;
  distro: Record<string, string>;
  toolchain: Record<string, string>;
  source: { version: string; url: string; sha256: string };
  manifest: { protocolMajor: number };
}

type BuildTarget =
  | { darwin: true; format: "darwin" }
  | { darwin: false; format: Format };
export type BuildContext = BuildInputs & BuildTarget;
export type BuildPrerequisites = Omit<
  BuildInputs,
  "work" | "payload" | "root" | "target" | "runtime" | "installPath"
> &
  BuildTarget;

export function isPackageFormat(value: string): value is PackageFormat {
  return value === "darwin" || Object.hasOwn(PACKAGE_FORMATS, value);
}
