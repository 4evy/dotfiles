import { copyFile, mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIfChanged } from "../../lib/typescript/files.ts";
import {
  updateBrowser,
  updateBunBootstrap,
  updateChatgpt,
  updateMise,
} from "./checksums.ts";
import { validateGhostty } from "./ghostty.ts";
import { updateRenovatePatch } from "./patch.ts";
import { execute, root, run } from "./process.ts";

async function changedPaths(): Promise<Set<string>> {
  const result = await execute(["git", "diff", "HEAD", "--name-only", "-z"]);
  if (result.code !== 0)
    throw new Error(`git diff failed (${result.code}): ${result.stderr.trim()}`);
  return new Set(result.stdout.split("\0").filter(Boolean));
}

// Every dependency update must refresh its generated hashes and lockfiles before
// it can become a commit on master; failed commands must never produce PRs or issues
let changed = await changedPaths();

if (
  ["go.work", "tools/records/go.mod", "tools/theme/run/go.mod"].some((file) =>
    changed.has(file),
  )
)
  await run(["go", "work", "sync"]);

changed = await changedPaths();

const pinUpdates = [
  { input: ".github/renovate/package.json", update: updateRenovatePatch },
  { input: "tools/setup/setup.sh", update: updateBunBootstrap },
  { input: ".github/actions/setup-check-tools/action.yaml", update: updateMise },
  { input: "home/applications/helium/config.toml", update: updateBrowser },
  {
    input: "home/files/.local/share/nix/chatgpt/package.nix",
    update: async () => {
      await updateChatgpt();
      await run([
        "deadnix",
        "--fail",
        "home/files/.local/share/nix/chatgpt/package.nix",
      ]);
    },
  },
];
for (const { input, update } of pinUpdates) {
  if (changed.has(input)) await update();
}
if (changed.has("package.json")) {
  const manifest = await Bun.file(join(root, "package.json")).json();
  const path = join(root, "biome.jsonc");
  const content = await Bun.file(path).text();
  const schema = /https:\/\/biomejs\.dev\/schemas\/[^/]+\/schema\.json/g;
  if ([...content.matchAll(schema)].length !== 1)
    throw new Error("Expected one Biome schema version binding");
  const version = manifest.devDependencies["@biomejs/biome"];
  if (typeof version !== "string" || !version) throw new Error("Missing Biome version");
  writeIfChanged(
    path,
    content.replace(schema, () => `https://biomejs.dev/schemas/${version}/schema.json`),
  );
}
if (changed.has("flake.nix") || changed.has("flake.lock")) {
  await run(["nix", "flake", "lock"]);
  await validateGhostty();
}

const chatgpt = "home/files/.local/share/nix/chatgpt";
if (changed.has(`${chatgpt}/flake.nix`) || changed.has(`${chatgpt}/flake.lock`)) {
  await using workspace = await mkdtempDisposable(join(tmpdir(), "chatgpt-lock-"));
  const staging = workspace.path;
  // Recompute the managed lock in an isolated flake directory
  await copyFile(join(root, chatgpt, "flake.nix"), join(staging, "flake.nix"));
  await copyFile(join(root, chatgpt, "flake.lock"), join(staging, "flake.lock"));
  await run(["nix", "flake", "update"], staging);
  await copyFile(join(staging, "flake.lock"), join(root, chatgpt, "flake.lock"));
}

const yazi = "home/files/.config/yazi/package.toml";
if (changed.has(yazi)) {
  await using workspace = await mkdtempDisposable(join(tmpdir(), "yazi-packages-"));
  const staging = workspace.path;
  // Recompute plugin hashes in an isolated config, never in the user's Yazi
  await copyFile(join(root, yazi), join(staging, "package.toml"));
  await run(["ya", "pkg", "install"], staging, {
    ...process.env,
    YAZI_CONFIG_HOME: staging,
  });
  await copyFile(join(staging, "package.toml"), join(root, yazi));
}

// Workspace manifests refresh their owning lockfile, not a nested lockfile
for (const { directory, inputs, nix } of [
  {
    directory: ".",
    inputs: ["package.json", "home/package.json", "bun.lock"],
    nix: false,
  },
  {
    directory: ".github/renovate",
    inputs: [".github/renovate/package.json", ".github/renovate/bun.lock"],
    nix: false,
  },
  {
    directory: "home/files/.local/lib/typescript",
    inputs: [
      "home/files/.local/lib/typescript/package.json",
      "home/files/.local/lib/typescript/bun.lock",
    ],
    nix: false,
  },
  {
    directory: "tools/tiling",
    inputs: ["tools/tiling/package.json", "tools/tiling/bun.lock"],
    nix: true,
  },
  {
    directory: "tools/workstation",
    inputs: ["tools/workstation/package.json", "tools/workstation/bun.lock"],
    nix: true,
  },
]) {
  if (!inputs.some((input) => changed.has(input))) continue;
  await run(
    ["bun", "install", "--ignore-scripts", "--lockfile-only"],
    join(root, directory),
  );
  if (!nix) continue;
  const output = `${directory}/bun.nix`;
  await run([
    "nix",
    "run",
    ".#bun2nix",
    "--",
    "--lock-file",
    `${directory}/bun.lock`,
    // Local dependencies resolve beside the generated bun.nix
    "--copy-prefix",
    "./",
    "--output-file",
    output,
  ]);
  await run(["deadnix", "--edit", output]);
  await run(["nixfmt", output]);
}

if (changed.has("tools/theme/run/go.mod") || changed.has("tools/theme/run/go.sum")) {
  // buildGoModule hashes the recursive vendor output, including generated files
  const derivation = await run([
    "nix",
    "eval",
    "--raw",
    ".#packages.x86_64-linux.theme-run.goModules",
    "--apply",
    'modules: (modules.overrideAttrs (_: { outputHash = ""; outputHashAlgo = "sha256"; })).drvPath',
  ]);
  const result = await execute(["nix", "build", "--no-link", `${derivation}^*`]);
  const hash = result.stderr.match(/got:\s+(sha256-[A-Za-z0-9+/]+=)/)?.[1];
  if (!hash) throw new Error(`Could not calculate Go vendor hash: ${result.stderr}`);
  const path = join(root, "tools/theme/run/package.nix");
  const content = await Bun.file(path).text();
  const binding = /vendorHash = "[^"\n]+";/g;
  if ([...content.matchAll(binding)].length !== 1)
    throw new Error("Expected one Go vendor hash binding");
  writeIfChanged(
    path,
    content.replace(binding, () => `vendorHash = "${hash}";`),
  );
  await run(["deadnix", "--fail", "tools/theme/run/package.nix"]);
  await run(["nixfmt", "tools/theme/run/package.nix"]);
}
