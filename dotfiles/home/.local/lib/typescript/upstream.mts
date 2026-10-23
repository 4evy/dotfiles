import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve from the caller's project, not the managed compiler installation
const require = createRequire(join(process.cwd(), "package.json"));
let compiler: string;
try {
  compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
    console.error("tscn: install typescript in the current project first");
    process.exit(1);
  }
  throw error;
}

// The preload has already run for this module, so import the CLI in-process
// Keep NODE_OPTIONS and BUN_OPTIONS intact for unrelated child commands
process.argv[1] = compiler;
await import(pathToFileURL(compiler).href);
