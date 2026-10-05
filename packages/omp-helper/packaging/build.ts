import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { packageDarwin } from "./darwin";
import { stageDesktop } from "./desktop";
import { help } from "./help";
import { packageLinux } from "./linux";
import { buildPrerequisites } from "./prerequisites";
import { stageRuntime } from "./runtime";
import { type BuildContext, isPackageFormat } from "./targets";

const BUILD_OPTIONS = {
  format: { type: "string" },
  output: { type: "string" },
  release: { type: "string", default: "1" },
  "install-root": { type: "string", default: "/opt/omp-helper" },
  help: { type: "boolean" },
} as const;

async function build(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: BUILD_OPTIONS,
    strict: true,
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (!values.format || !isPackageFormat(values.format) || !values.output)
    throw new Error(help);
  const inputs = await buildPrerequisites(values.format, values.output, values.release);
  const installRoot = values["install-root"];
  if (installRoot !== "/opt/omp-helper" && installRoot !== "/usr/lib/omp-helper")
    throw new Error("--install-root must be /opt/omp-helper or /usr/lib/omp-helper");
  if (inputs.darwin && installRoot !== "/opt/omp-helper")
    throw new Error("--install-root is only supported for Linux packages");
  const work = await mkdtemp(join(tmpdir(), "omp-helper-package-"));
  try {
    const payload = join(work, "payload");
    const installPath = `${installRoot}/${inputs.version}`;
    const root = join(payload, "lib/omp-helper");
    const target = join(root, "packages/omp-helper");
    const runtime = join(payload, "lib/omp-runtime");
    const context: BuildContext = {
      ...inputs,
      work,
      payload,
      root,
      target,
      runtime,
      installPath,
    };
    const nativePackage = await stageRuntime(context);
    if (context.darwin) await packageDarwin(context);
    else {
      await stageDesktop(context);
      await packageLinux(context, nativePackage);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await build().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
