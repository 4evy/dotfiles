import { arch } from "node:os";

// Supply public host paths to Nix without the full process environment
export async function buildHjemOutput(
  repository: string,
  output: "hjemHome" | "hjemConfiguration",
  environment: NodeJS.ProcessEnv,
  outLink?: string,
): Promise<string> {
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
  async function run(command: string[]): Promise<string> {
    const child = Bun.spawn(command, {
      cwd: repository,
      env: environment,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    });
    const result = await new Response(child.stdout).text();
    if ((await child.exited) !== 0)
      throw new Error(`Hjem ${output}: ${command[0]} failed`);
    return result.trim();
  }
  const derivation = await run([
    "nix",
    "eval",
    "--impure",
    "--raw",
    `${repository}#lib.${output}`,
    "--apply",
    `build: (build ${argument}).drvPath`,
  ]);
  return run([
    "nix",
    "build",
    `${derivation}^*`,
    ...(outLink ? ["--out-link", outLink] : ["--no-link"]),
    "--print-out-paths",
  ]);
}
