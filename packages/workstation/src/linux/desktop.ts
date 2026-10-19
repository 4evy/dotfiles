import * as v from "valibot";
import { run } from "../../../../lib/typescript/commands.ts";
import { DotfilesError } from "../../../../lib/typescript/errors.ts";
import source from "../../assets/linux/desktop.gjs" with { type: "text" };

export function desktopArguments(...args: string[]): string[] {
  return ["gjs", "-c", source, ...args];
}

export function desktopOutput(...args: string[]): string {
  const result = run(desktopArguments(...args), { capture: true, check: false });
  if (result.code !== 0)
    throw new DotfilesError(`Desktop ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.replace(/\n+$/, "");
}

export function flatpakRefs(kind: "apps" | "runtimes") {
  return v.parse(
    v.array(
      v.object({
        id: v.string(),
        branch: v.string(),
        arch: v.string(),
        origin: v.nullable(v.string()),
        installation: v.string(),
      }),
    ),
    JSON.parse(desktopOutput(`flatpak-${kind}`)),
  );
}
