import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths, withMaintenanceLock } from "../state";
export async function replaceLink(path: string, target: string): Promise<void> {
  const staged = `${path}.${randomUUID()}`;
  await symlink(target, staged);
  try {
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

export function createInstallerLock<Preparation extends { maintenanceToken: string }>(
  prepared: () => Promise<Preparation | undefined>,
) {
  return async function installerLock<T>(
    token: string | undefined,
    work: (preparation?: Preparation) => Promise<T>,
  ): Promise<T> {
    if (token === undefined) return withMaintenanceLock(() => work());
    z.uuid().parse(token);
    const lock = join(paths().state, "maintenance.lock");
    const preparation = await prepared();
    if (!preparation || preparation.maintenanceToken !== token)
      throw new Error("Maintenance token does not match the pending upgrade");
    const operation = join(lock, "operation");
    await mkdir(operation, { mode: 0o700 });
    let complete = false;
    try {
      if ((await prepared())?.maintenanceToken !== token)
        throw new Error("Pending maintenance changed");
      const result = await work(preparation);
      complete = true;
      return result;
    } finally {
      if (complete) await rm(lock, { recursive: true });
      else await rm(operation, { recursive: true, force: true });
    }
  };
}
