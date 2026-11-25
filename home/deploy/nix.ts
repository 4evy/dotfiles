import { output as commandOutput } from "@dotfiles/core/commands";
import { Effect, FileSystem } from "effect";

// Supply public host paths to Nix without the full process environment
export const buildHjemOutput = Effect.fn("buildHjemOutput")(function* (
  repository: string,
  output: "hjemHome" | "hjemConfiguration",
  environment: NodeJS.ProcessEnv,
  outLink?: string,
) {
  let platform = environment.HJEM_PLATFORM;
  if (!platform && process.platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    platform = (yield* fs.exists("/etc/NIXOS")) ? "nixos" : "linux";
  }
  const architecture = process.arch;
  const runtime = {
    system: `${architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : architecture}-${process.platform}`,
    environment: {
      ...Object.fromEntries(
        [
          "HOME",
          "PATH",
          "HOMEBREW_PREFIX",
          "HJEM_WORKING_TREE",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ].map((name) => [name, environment[name] || ""]),
      ),
      HJEM_PLATFORM: platform || "",
    },
  };
  const argument = JSON.stringify(JSON.stringify(runtime)).replaceAll("${", "\\${");
  const options = {
    cwd: repository,
    env: environment,
    stdin: "inherit",
    stderr: "inherit",
  } as const;
  const derivation = (yield* commandOutput(
    [
      "nix",
      "eval",
      "--impure",
      "--raw",
      `${repository}#lib.${output}`,
      "--apply",
      `build: (build ${argument}).drvPath`,
    ],
    options,
  )).trim();
  return (yield* commandOutput(
    [
      "nix",
      "build",
      `${derivation}^*`,
      ...(outLink ? ["--out-link", outLink] : ["--no-link"]),
      "--print-out-paths",
    ],
    options,
  )).trim();
});
