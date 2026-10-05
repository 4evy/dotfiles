import { quotePosixPath as quote } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import {
  type Manager,
  type Platform,
  type SupportedManager,
  selectManager,
} from "./platform";

export type Operation = "install" | "upgrade" | "uninstall";

export type Request = {
  action: "inspect" | "plan" | "install" | "upgrade" | "uninstall";
  operation?: Operation | undefined;
  manager?: Manager | undefined;
  artifact?: string | undefined;
  sha256?: string | undefined;
  waylandDisplay?: string | undefined;
  maintenanceToken?: string | undefined;
};

export const currentHelper = `"\${XDG_DATA_HOME:-$HOME/.local/share}/omp-helper/current/bin/omp-helper"`;
const nativeHelper = "/usr/bin/omp-helper";

export function activationCommand(
  executable: string,
  action: string | readonly string[],
  request: Partial<Request>,
  packagePath?: string,
): string {
  const args = typeof action === "string" ? [action] : [...action];
  if (packagePath) args.push("--package-path", packagePath);
  if (request.waylandDisplay) args.push("--wayland-display", request.waylandDisplay);
  if (request.maintenanceToken)
    args.push("--maintenance-token", request.maintenanceToken);
  return `${executable} ${args.map(quote).join(" ")}`;
}

type NativeManager = Exclude<SupportedManager, "nix" | "brew">;
type PackageCommands = { packageCommand: string | null; activation: string };
type PlanBuilder = (
  platform: Platform,
  operation: Operation,
  request: Request,
) => PackageCommands;

export const MANAGER_OWNERS = {
  apt: "dpkg",
  dnf: "rpm",
  yum: "rpm",
  pacman: "pacman",
  zypper: "rpm",
  nix: "nix",
  brew: "brew",
} as const satisfies Record<SupportedManager, string>;

const NATIVE_PACKAGES = {
  apt: {
    extension: "deb",
    remove: "apt-get remove --yes omp-helper",
    verify: (file: string) => `test "$(dpkg-deb --field ${file} Package)" = omp-helper`,
    install: (file: string) =>
      `DEBIAN_FRONTEND=noninteractive apt-get install --yes ${file}`,
  },
  dnf: {
    extension: "rpm",
    remove: "dnf remove --assumeyes omp-helper",
    verify: rpmVerification,
    install: (file: string) => `dnf install --assumeyes ${file}`,
  },
  yum: {
    extension: "rpm",
    remove: "yum remove --assumeyes omp-helper",
    verify: rpmVerification,
    install: (file: string) => `yum install --assumeyes ${file}`,
  },
  pacman: {
    extension: "pkg.tar.zst",
    remove: "pacman --remove --noconfirm omp-helper",
    verify: (file: string) =>
      `metadata=$(pacman --query --file ${file})\ntest "\${metadata%% *}" = omp-helper`,
    install: (file: string) => `pacman --upgrade --noconfirm ${file}`,
  },
  zypper: {
    extension: "rpm",
    remove: "zypper --non-interactive remove omp-helper",
    verify: rpmVerification,
    install: (file: string) =>
      `zypper --non-interactive install --allow-unsigned-rpm ${file}`,
  },
} satisfies Record<
  NativeManager,
  {
    extension: string;
    remove: string;
    verify(file: string): string;
    install(file: string): string;
  }
>;

function rpmVerification(file: string): string {
  return `test "$(rpm --query --package --queryformat '%{NAME}' ${file})" = omp-helper`;
}

const NATIVE_WARNINGS = [
  "Use an artifact built for this distribution, release and architecture; package metadata alone does not establish ABI compatibility",
  "Native package changes are system-wide; activation and busy-work checks cover only the connected user",
  "Package-manager transactions cannot be rolled back by the helper; failed upgrades retain a maintenance gate for explicit recovery",
];
const MANAGER_WARNINGS = {
  apt: NATIVE_WARNINGS,
  dnf: NATIVE_WARNINGS,
  yum: NATIVE_WARNINGS,
  pacman: NATIVE_WARNINGS,
  zypper: NATIVE_WARNINGS,
  nix: [
    "Nix store GC roots manage this per-user installation; no system package or default profile is modified",
  ],
  brew: [
    "Requires the existing 4evy/dotfiles local tap with Formula/omp-helper.rb; no sudo or launchd service is used",
    "Homebrew cleanup is disabled during installation so the old keg remains available for explicit upgrade recovery",
    "macOS supports managed jobs only; Linux desktop tools are unavailable",
  ],
} satisfies Record<SupportedManager, string[]>;
const OPERATION_ORDER = {
  install: ["prepare-if-upgrading", "install-package", "activate"],
  upgrade: ["prepare-if-upgrading", "install-package", "activate"],
  uninstall: ["deactivate", "remove-package"],
} satisfies Record<Operation, string[]>;

/** Native artifacts are copied into a root-owned directory before verification */
function nativeTransaction(
  manager: NativeManager,
  operation: Operation,
  request: Request,
): string {
  const policy = NATIVE_PACKAGES[manager];
  if (operation === "uninstall") return policy.remove;
  const source = request.artifact;
  if (!source?.startsWith("/") || /[\0\r\n]/u.test(source))
    throw new Error(
      "Native installation requires an absolute remote artifact path without control characters",
    );
  if (!request.sha256 || !/^[a-fA-F0-9]{64}$/u.test(request.sha256))
    throw new Error("Native installation requires the artifact's expected SHA-256");
  const family = policy.extension;
  if (!source.endsWith(`.${family}`))
    throw new Error(
      `${manager} requires a .${family} artifact built for this host's distribution and architecture`,
    );
  const file = `"$stage/package.${family}"`;
  return [
    "set -eu",
    "umask 077",
    "stage=$(mktemp -d /var/tmp/omp-helper-package.XXXXXXXX)",
    "trap 'rm -rf -- \"$stage\"' EXIT",
    `cp -- ${quote(source)} ${file}`,
    `printf '%s  %s\\n' ${quote(request.sha256.toLowerCase())} ${file} | sha256sum --check --status`,
    `${policy.verify(file)} || { printf '%s\\n' 'Artifact is not an omp-helper package' >&2; exit 65; }`,
    policy.install(file),
  ].join("\n");
}

function nixPlan(
  _platform: Platform,
  operation: Operation,
  request: Request,
): PackageCommands {
  if (
    operation !== "uninstall" &&
    !/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/u.test(request.artifact ?? "")
  ) {
    throw new Error(
      "Nix installation requires a realized /nix/store output in artifact; build or copy the trusted omp-helper flake output first",
    );
  }
  const activation =
    operation === "uninstall"
      ? activationCommand(currentHelper, "uninstall", request)
      : `nix-store --query --hash ${quote(request.artifact ?? "")} >/dev/null && ${activationCommand(quote(`${request.artifact}/bin/omp-helper`), operation, request, request.artifact)}`;
  return { packageCommand: null, activation };
}

function brewPlan(
  platform: Platform,
  operation: Operation,
  request: Request,
): PackageCommands {
  let packageCommand: string;
  let activation: string;
  if (request.waylandDisplay)
    throw new Error("Wayland desktop activation is unavailable on macOS");
  const executable =
    platform.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
  const brew = `brew=${quote(executable)}; command -v brew >/dev/null 2>&1 && brew=$(command -v brew); export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1`;
  if (operation === "uninstall") {
    packageCommand = `${brew}\n"$brew" uninstall 4evy/dotfiles/omp-helper`;
    activation = activationCommand(currentHelper, "uninstall", request);
  } else {
    const source = request.artifact;
    const filename = source?.slice(source.lastIndexOf("/") + 1);
    const architecture = platform.arch === "arm64" ? "arm64" : "x64";
    if (
      !source?.startsWith("/") ||
      /[\0\r\n]/u.test(source) ||
      !filename ||
      !new RegExp(
        `^omp-helper-\\d+\\.\\d+\\.\\d+\\.[1-9]\\d*-darwin-${architecture}\\.tar\\.gz$`,
        "u",
      ).test(filename)
    )
      throw new Error(
        "Homebrew requires an absolute Darwin archive from packaging/build.ts for this Mac's architecture",
      );
    if (!request.sha256 || !/^[a-fA-F0-9]{64}$/u.test(request.sha256))
      throw new Error("Homebrew installation requires the archive's expected SHA-256");
    const metadata = JSON.stringify({
      archive: filename,
      sha256: request.sha256.toLowerCase(),
    });
    packageCommand = [
      "set -eu",
      "umask 077",
      brew,
      'tap=$("$brew" --repository 4evy/dotfiles)',
      'test -f "$tap/Formula/omp-helper.rb" || { printf "%s\\n" "Sync Formula/omp-helper.rb to the existing 4evy/dotfiles local tap first" >&2; exit 65; }',
      'mkdir -p "$tap/Sources"',
      'stage=$(mktemp -d "$tap/Sources/.omp-helper.XXXXXXXX")',
      "trap 'rm -rf \"$stage\"' EXIT",
      `cp ${quote(source)} "$stage/payload.tar.gz"`,
      `printf '%s  %s\\n' ${quote(request.sha256.toLowerCase())} "$stage/payload.tar.gz" | shasum -a 256 --check --status`,
      `mv "$stage/payload.tar.gz" "$tap/Sources/${filename}"`,
      `printf '%s\\n' ${quote(metadata)} > "$stage/omp-helper.json"`,
      'mv "$stage/omp-helper.json" "$tap/Sources/omp-helper.json"',
      `"$brew" ${operation === "upgrade" ? "upgrade" : "install"} --formula 4evy/dotfiles/omp-helper`,
    ].join("\n");
    activation = `${brew}\npackage=$("$brew" --prefix omp-helper)/libexec\n"$package/bin/omp-helper" ${[operation, ...(request.maintenanceToken ? ["--maintenance-token", request.maintenanceToken] : [])].map(quote).join(" ")}`;
  }
  return { packageCommand, activation };
}

function nativePlan(manager: NativeManager): PlanBuilder {
  return (_platform, operation, request) => ({
    packageCommand: nativeTransaction(manager, operation, request),
    activation: activationCommand(quote(nativeHelper), operation, request),
  });
}

const PLAN_BUILDERS = {
  apt: nativePlan("apt"),
  dnf: nativePlan("dnf"),
  yum: nativePlan("yum"),
  pacman: nativePlan("pacman"),
  zypper: nativePlan("zypper"),
  nix: nixPlan,
  brew: brewPlan,
} satisfies Record<SupportedManager, PlanBuilder>;

export function installationPlan(platform: Platform, request: Request) {
  const manager = selectManager(platform, request.manager);
  const operation =
    request.action === "plan" ? (request.operation ?? "install") : request.action;
  if (operation === "inspect")
    throw new Error("Inspection does not need an installation plan");
  if (operation !== "uninstall" && platform.os === "Linux" && !platform.systemdUser)
    throw new Error(
      "The selected SSH user has no reachable systemd user manager; establish the user session before activation",
    );
  const { packageCommand, activation } = PLAN_BUILDERS[manager](
    platform,
    operation,
    request,
  );
  return {
    manager,
    operation,
    privileged: packageCommand !== null && manager !== "brew",
    packageCommand,
    activation,
    prepare:
      operation === "upgrade" && manager !== "nix" && !request.maintenanceToken
        ? activationCommand(currentHelper, ["upgrade", "prepare"], {})
        : null,
    order: [...OPERATION_ORDER[operation]],
    artifact: request.artifact ?? null,
    sha256: request.sha256?.toLowerCase() ?? null,
    warnings: [...MANAGER_WARNINGS[manager]],
  };
}
