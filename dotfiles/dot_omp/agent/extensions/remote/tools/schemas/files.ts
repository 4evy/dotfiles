import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function createFileParameters(api: ExtensionAPI) {
  const z = api.zod;
  const target = {
    connection: z.string().min(1),
    path: z
      .string()
      .min(1)
      .describe("Remote absolute, ~/ or connection-relative literal path"),
  };
  const expectedHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional()
    .describe("SHA-256 from remote_read; reject stale content");
  const readParameters = z.object({
    ...target,
    selector: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Native read selector, e.g. 1-100 or raw; separate from the literal path",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Directory entry offset; default 0"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Directory entry limit; default 200"),
  });
  const writeParameters = z.object({
    ...target,
    content: z.string().max(MAX_FILE_BYTES),
  });
  const editParameters = z.object({
    ...target,
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
    expectedHash,
  });
  const deleteParameters = z.object(target);
  return { readParameters, writeParameters, editParameters, deleteParameters };
}

export type FileParameters = ReturnType<typeof createFileParameters>;
