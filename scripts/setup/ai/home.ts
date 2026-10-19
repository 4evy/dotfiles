import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export async function prepareAiHome(
  source: string,
  exported: string,
  destination: string,
  nativeCli: string,
  farstep = join(source, "farstep/farstep"),
): Promise<void> {
  const home = homedir();
  const manifest = await Bun.file(join(exported, "manifest.json")).json();
  const files: { path: string; private: boolean; type?: "symlink" }[] = [];
  const write = async (path: string, contents: string) => {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o600 });
    files.push({ path, private: true });
  };
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      isAbsolute(file.path) ||
      file.path.split("/").some((part: string) => ["", ".", ".."].includes(part))
    )
      throw new Error("The AI config export contains an invalid destination");
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (file.path === ".codex/config.toml" && existsSync(join(home, file.path))) {
      const current = Bun.TOML.parse(await readFile(join(home, file.path), "utf8"));
      const managed = Bun.TOML.parse(await readFile(join(exported, file.path), "utf8"));
      const merge = (
        left: Record<string, unknown>,
        right: Record<string, unknown>,
      ): Record<string, unknown> => {
        for (const [key, value] of Object.entries(right)) {
          const previous = left[key];
          left[key] =
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            previous &&
            typeof previous === "object" &&
            !Array.isArray(previous)
              ? merge(
                  previous as Record<string, unknown>,
                  value as Record<string, unknown>,
                )
              : value;
        }
        return left;
      };
      const contents = Bun.TOML.stringify(
        merge(current as Record<string, unknown>, managed as Record<string, unknown>),
      );
      await writeFile(target, contents, { mode: 0o600 });
    } else await copyFile(join(exported, file.path), target);
    await chmod(target, file.private ? 0o600 : 0o644);
    files.push({ path: file.path, private: Boolean(file.private) });
  }
  const links = {
    ".local/bin/ai": "tools/scripts/cli/ai.sh",
    ".local/bin/claude": "apps/claude/claude.ts",
    ".local/bin/codex": "apps/codex/codex.ts",
    ".local/bin/farstep": farstep,
    ".local/bin/omp": "apps/omp/omp",
    ".local/bin/opencode": "apps/opencode/opencode.ts",
    ".omp/agent/lib/schema": "apps/omp/lib/schema",
    ".omp/agent/lib/sky": "farstep/sky",
    ".omp/agent/extensions/remote": "apps/omp/extensions/remote",
    ".omp/agent/extensions/skylight": "apps/omp/extensions/skylight",
    ".omp/agent/extensions/thinking": "apps/omp/extensions/thinking",
  };
  for (const [path, relative] of Object.entries(links)) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await symlink(isAbsolute(relative) ? relative : join(source, relative), target);
    files.push({ path, private: false, type: "symlink" });
  }
  if (process.platform === "linux") {
    await write(
      ".config/environment.d/60-codex-cli.conf",
      `CODEX_CLI_PATH=${JSON.stringify(nativeCli)}\n`,
    );
    await write(
      ".config/systemd/user/ghidra-mcp.service",
      `[Unit]\nDescription=Ghidra MCP headless backend\n\n[Service]\nExecStart=${JSON.stringify(join(home, ".local/bin/ai"))} ghidra mcp httpd\nUMask=0077\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
    );
  }
  await writeFile(
    join(destination, "manifest.json"),
    `${JSON.stringify({ version: 1, platform: process.platform, files })}\n`,
    { mode: 0o600 },
  );
}
