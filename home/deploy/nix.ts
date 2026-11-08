import { arch } from "node:os";
import { output as commandOutput } from "@dotfiles/core/commands";
import { Effect } from "effect";

// Supply public host paths to Nix without the full process environment
export const buildHjemOutput = Effect.fn("buildHjemOutput")(function* (
  repository: string,
  output: "hjemHome" | "hjemConfiguration",
  environment: NodeJS.ProcessEnv,
  outLink?: string,
) {
  const runtime = {
    system: `${arch() === "arm64" ? "aarch64" : arch() === "x64" ? "x86_64" : arch()}-${process.platform}`,
    environment: Object.fromEntries(
      [
        "HOME",
        "PATH",
        "HOMEBREW_PREFIX",
        "HJEM_WORKING_TREE",
        "HJEM_PLATFORM",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].map((name) => [name, environment[name] || ""]),
    ),
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
