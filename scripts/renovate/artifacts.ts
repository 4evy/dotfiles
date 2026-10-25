import { copyFile, mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  updateBrowser,
  updateBunBootstrap,
  updateChatgpt,
  updateMise,
} from "./checksums.ts";
import { validateGhostty } from "./ghostty.ts";
import { updateRenovatePatch } from "./patch.ts";
import { execute, root, run } from "./process.ts";

// Every dependency update must refresh its generated hashes and lockfiles before
// it can become a commit on master; failed commands must never produce PRs or issues
let changed = new Set((await run(["git", "diff", "HEAD", "--name-only"])).split("\n"));

if (
  ["go.work", "packages/records/go.mod", "packages/theme-run/go.mod"].some((file) =>
    changed.has(file),
  )
)
  await run(["go", "work", "sync"]);

changed = new Set((await run(["git", "diff", "HEAD", "--name-only"])).split("\n"));

if (changed.has(".github/renovate/package.json")) await updateRenovatePatch();
if (changed.has("scripts/setup/setup.sh")) await updateBunBootstrap();
if (changed.has("package.json")) {
  const manifest = await Bun.file(join(root, "package.json")).json();
  const path = join(root, "biome.jsonc");
  const content = await Bun.file(path).text();
  await Bun.write(
    path,
    content.replace(
      /https:\/\/biomejs\.dev\/schemas\/[^/]+\/schema\.json/,
      `https://biomejs.dev/schemas/${manifest.devDependencies["@biomejs/biome"]}/schema.json`,
    ),
  );
}
if (changed.has(".github/actions/setup-check-tools/action.yaml")) await updateMise();
if (changed.has("browser/helium.toml")) await updateBrowser();
if (changed.has("dotfiles/home/.local/share/nix/chatgpt/package.nix")) {
  await updateChatgpt();
  await run([
    "deadnix",
    "--fail",
    "dotfiles/home/.local/share/nix/chatgpt/package.nix",
  ]);
}
if (changed.has("flake.nix") || changed.has("flake.lock")) {
  await run(["nix", "flake", "lock"]);
  await validateGhostty();
}

const chatgpt = "dotfiles/home/.local/share/nix/chatgpt";
if (changed.has(`${chatgpt}/flake.lock`)) {
  await using workspace = await mkdtempDisposable(join(tmpdir(), "chatgpt-lock-"));
  const staging = workspace.path;
  // Recompute the managed lock in an isolated flake directory
  await copyFile(join(root, chatgpt, "private_flake.nix"), join(staging, "flake.nix"));
  await copyFile(
    join(root, chatgpt, "private_flake.lock"),
    join(staging, "flake.lock"),
  );
  await run(["nix", "flake", "update"], staging);
  await copyFile(
    join(staging, "flake.lock"),
    join(root, chatgpt, "private_flake.lock"),
  );
}

const yazi = "dotfiles/home/.config/yazi/package.toml";
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

for (const directory of [
  ".",
  ".github/renovate",
  "dotfiles/home/.local/lib/typescript",
  "packages/hyper-window-tiling",
  "packages/workstation",
]) {
  const prefix = directory === "." ? "" : `${directory}/`;
  if (!changed.has(`${prefix}package.json`) && !changed.has(`${prefix}bun.lock`))
    continue;
  await run(
    ["bun", "install", "--ignore-scripts", "--lockfile-only"],
    join(root, directory),
  );
  if (!["packages/hyper-window-tiling", "packages/workstation"].includes(directory))
    continue;
  const output = `${directory}/bun.nix`;
  await run([
    "nix",
    "run",
    ".#bun2nix",
    "--",
    "--lock-file",
    `${directory}/bun.lock`,
    "--copy-prefix",
    directory,
    "--output-file",
    output,
  ]);
  await run(["deadnix", "--edit", output]);
  await run(["nixfmt", output]);
}

if (
  changed.has("packages/theme-run/go.mod") ||
  changed.has("packages/theme-run/go.sum")
) {
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
  const path = join(root, "packages/theme-run/package.nix");
  const content = await Bun.file(path).text();
  await Bun.write(
    path,
    content.replace(/vendorHash = "[^"\n]+";/, `vendorHash = "${hash}";`),
  );
  await run(["deadnix", "--fail", "packages/theme-run/package.nix"]);
  await run(["nixfmt", "packages/theme-run/package.nix"]);
}
