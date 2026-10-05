import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildContext } from "./targets";
export async function reportArtifact(
  artifact: string,
  { format, version, release, distro, architecture }: BuildContext,
): Promise<void> {
  const sha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  console.log(
    JSON.stringify({
      artifact,
      sha256,
      format,
      architecture,
      version,
      release,
      distro,
    }),
  );
}

export async function run(
  args: string[],
  cwd: string,
  env = process.env,
): Promise<void> {
  const child = Bun.spawn(args, { cwd, env, stdout: 2, stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code})`);
}

export async function copy(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

export async function* files(root: string): AsyncGenerator<string> {
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(root, entry.name);
    yield path;
    if (entry.isDirectory()) yield* files(path);
  }
}
