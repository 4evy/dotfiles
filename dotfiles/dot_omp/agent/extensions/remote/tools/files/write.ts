import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { writeRemoteFile } from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import type { FileParameters } from "../schemas/files";
import { MAX_FILE_BYTES } from "../schemas/files";
import { hash, staging } from "./shared";

export function registerWriteTool(
  api: ExtensionAPI,
  { selected }: Connections,
  { writeParameters }: FileParameters,
) {
  api.registerTool({
    name: "remote_write",
    label: "Write remote file",
    description:
      "Create or overwrite a remote file using native OMP write handling and SSH staging. Creates parent directories; existing regular-file permissions are preserved. Symlinks to files are replaced.",
    parameters: writeParameters,
    loadMode: "discoverable",
    approval: "write",
    async execute(id, input, signal): Promise<AgentToolResult<unknown>> {
      const args = writeParameters.parse(input);
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      if (args.path.endsWith("/"))
        throw new Error("Write requires a file path without a trailing slash");
      return staging(path, async (file, session) => {
        const result = await new WriteTool(session).execute(
          id,
          { path: file, content: args.content },
          signal,
        );
        if (result.isError) return result;
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES)
          throw new Error("Content exceeds the 16 MiB transfer limit");
        await writeRemoteFile(connection.target, path, bytes, signal ? { signal } : {});
        return {
          content: [{ type: "text", text: `Wrote ${bytes.length} bytes to ${path}` }],
          details: {
            connectionId: connection.id,
            path,
            sha256: hash(bytes),
            bytes: bytes.length,
          },
        };
      });
    },
  });
}
