import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function createConnectionParameters(api: ExtensionAPI) {
  const z = api.zod;
  const connectParameters = z.object({
    target: z.string().min(1).describe("OMP host name, OpenSSH alias, or user@host"),
    id: z.string().min(1).optional().describe("Readable connection id"),
    username: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    keyPath: z.string().optional().describe("Local SSH identity file override"),
    cwd: z.string().optional().describe("Remote cwd; defaults to remote home"),
  });
  return { connectParameters };
}
