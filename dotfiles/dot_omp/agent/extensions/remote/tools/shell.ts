import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface ShellArgs {
  connection?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
}

export const shellArguments = {
  resolveCommand: (args: ShellArgs | undefined) => args?.command,
  resolveCwd: (args: ShellArgs | undefined) => args?.cwd,
};

export function commandFields(api: ExtensionAPI) {
  const z = api.zod;
  // The injected omptype builder supports object shapes, not Zod's extend API
  return {
    connection: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().optional(),
  };
}
