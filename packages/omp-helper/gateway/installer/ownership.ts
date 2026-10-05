import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../state";
import { locations, WORKSPACE_EXTENSION_FILES } from "./locations";
import type { Generation, InstallationRecord } from "./schemas";

function fileInventory(
  record: InstallationRecord | undefined,
  baseFiles: string[],
  managedFiles: string[],
) {
  const files = new Map(record?.files.map((file) => [file.path, file]));
  if (!record) return files;
  if (
    (record.files.length !== baseFiles.length &&
      record.files.length !== managedFiles.length) ||
    files.size !== record.files.length ||
    baseFiles.some((path) => !files.has(path)) ||
    record.files.some((file) => !managedFiles.includes(file.path))
  )
    throw new Error("Installer record contains an invalid owned-file inventory");
  return files;
}

async function assertFile(
  file: string,
  expected: InstallationRecord["files"][number] | undefined,
): Promise<void> {
  if (!(await exists(file))) {
    if (expected) throw new Error(`Owned installation file is missing: ${file}`);
    return;
  }
  const info = await lstat(file);
  if (
    !expected ||
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") !== expected.sha256
  )
    throw new Error(`Refusing to replace unrelated or modified file: ${file}`);
}

async function assertLink(
  link: string,
  generation: Generation | undefined,
): Promise<void> {
  if (!(await exists(link))) {
    if (generation) throw new Error(`Owned installation link is missing: ${link}`);
    return;
  }
  if (
    !generation ||
    !(await lstat(link)).isSymbolicLink() ||
    (await readlink(link)) !== generation.packagePath
  )
    throw new Error(`Refusing to replace unrelated installation link: ${link}`);
}

export async function assertOwned(
  record: InstallationRecord | undefined,
): Promise<void> {
  const p = locations();
  const baseFiles = [p.unit, p.descriptor, p.environment];
  const managedFiles = [
    ...baseFiles,
    ...WORKSPACE_EXTENSION_FILES.map((name) => join(p.workspaceExtension, name)),
  ];
  const inventory = fileInventory(record, baseFiles, managedFiles);
  for (const file of managedFiles) await assertFile(file, inventory.get(file));
  for (const [link, generation] of [
    [p.current, record?.current],
    [p.previous, record?.previous],
  ] as const)
    await assertLink(link, generation);
  if (
    (await exists(p.wants)) &&
    (!record ||
      !(await lstat(p.wants)).isSymbolicLink() ||
      (await realpath(p.wants)) !== (await realpath(p.unit)))
  )
    throw new Error(`Refusing unrelated graphical-session unit link: ${p.wants}`);
  for (const generation of [record?.current, record?.previous]) {
    if (generation?.manager !== "nix") continue;
    if (
      dirname(generation.root) !== p.roots ||
      !(await lstat(generation.root)).isSymbolicLink() ||
      (await readlink(generation.root)) !== generation.packagePath
    )
      throw new Error(
        "Installer GC root ownership does not match its recorded generation",
      );
  }
}
