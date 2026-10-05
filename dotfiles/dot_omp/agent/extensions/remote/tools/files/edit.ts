import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  statRemotePath,
  writeRemoteFile,
} from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import type { FileParameters } from "../schemas/files";
import { MAX_FILE_BYTES } from "../schemas/files";
import { checkHash, hash, readComplete, staging } from "./shared";

export function registerEditTool(
  api: ExtensionAPI,
  { selected }: Connections,
  { editParameters }: FileParameters,
) {
  api.registerTool({
    name: "remote_edit",
    label: "Edit remote file",
    description:
      "Update remote text with native OMP replace editing and diff output. Rejects ambiguous matches unless replace_all is true. Rechecks content before transfer; expectedHash additionally checks against an earlier read. Symlinks to files are replaced.",
    parameters: editParameters,
    loadMode: "discoverable",
    approval: "write",
    async execute(id, input, signal): Promise<AgentToolResult<unknown>> {
      const args = editParameters.parse(input);
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      if (
        (await statRemotePath(connection.target, path, signal ? { signal } : {})) !==
        "file"
      )
        throw new Error("Edit requires an existing regular file");
      const original = await readComplete(connection, path, signal);
      checkHash(original, args.expectedHash);
      new TextDecoder("utf-8", { fatal: true }).decode(original);
      if (original.includes(0)) throw new Error("Edit requires text without NUL bytes");
      return staging(path, async (file, session) => {
        await Bun.write(file, original);
        const result = await new EditTool(session, "replace").execute(
          id,
          {
            path: file,
            old_string: args.old_string,
            new_string: args.new_string,
            ...(args.replace_all === undefined
              ? {}
              : { replace_all: args.replace_all }),
          },
          signal,
        );
        if (result.isError) return result;
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES)
          throw new Error("Edited file exceeds the 16 MiB transfer limit");
        checkHash(await readComplete(connection, path, signal), hash(original));
        await writeRemoteFile(connection.target, path, bytes, signal ? { signal } : {});
        return {
          ...result,
          content: result.content.map((item) =>
            item.type === "text"
              ? { ...item, text: item.text.replaceAll(file, path) }
              : item,
          ),
          details: {
            ...result.details,
            path,
            connectionId: connection.id,
            sha256: hash(bytes),
          },
        };
      });
    },
  });
}
