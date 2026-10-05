import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  listRemoteDir,
  statRemotePath,
} from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { parseSel } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import type { FileParameters } from "../schemas/files";
import { hash, readComplete, staging } from "./shared";

export function registerReadTool(
  api: ExtensionAPI,
  { selected }: Connections,
  { readParameters }: FileParameters,
) {
  api.registerTool({
    name: "remote_read",
    label: "Read remote file",
    description:
      "Read remote files using native OMP formatting and selectors, or list a directory. Uses the saved SSH credentials without requiring omp-helper. Files up to 16 MiB; returns a full-file SHA-256 for edits.",
    parameters: readParameters,
    loadMode: "discoverable",
    approval: "read",
    async execute(id, input, signal): Promise<AgentToolResult<unknown>> {
      const args = readParameters.parse(input);
      if (args.selector && parseSel(args.selector).kind === "none")
        throw new Error(
          "Invalid native read selector; pass a range, raw, conflicts or img",
        );
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      const options = signal ? { signal } : {};
      const kind = await statRemotePath(connection.target, path, options);
      if (kind === "directory") {
        if (args.selector) throw new Error("Use offset/limit for directory listings");
        const entries = await listRemoteDir(connection.target, path, options);
        const offset = args.offset ?? 0;
        const page = entries.slice(offset, offset + (args.limit ?? 200));
        return {
          content: [
            {
              type: "text",
              text:
                page
                  .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
                  .join("\n") || "[No entries in this page]",
            },
          ],
          details: {
            connectionId: connection.id,
            path,
            totalEntries: entries.length,
            offset,
            truncated: offset + page.length < entries.length,
          },
        };
      }
      if (kind !== "file")
        throw new Error(`Remote path is ${kind}; expected a regular file or directory`);
      if (args.offset !== undefined || args.limit !== undefined)
        throw new Error(
          "Use selector for file ranges; offset/limit apply to directories",
        );
      const bytes = await readComplete(connection, path, signal);
      return staging(path, async (file, session) => {
        await Bun.write(file, bytes);
        const result = await new ReadTool(session).execute(
          id,
          { path: `${file}${args.selector ? `:${args.selector}` : ""}` },
          signal,
        );
        return {
          ...result,
          content: result.content.map((item) =>
            item.type === "text"
              ? {
                  ...item,
                  text: item.text.replaceAll(file, path),
                }
              : item,
          ),
          details: {
            ...result.details,
            path,
            connectionId: connection.id,
            sha256: hash(bytes),
            fileSize: bytes.length,
            meta: {
              ...result.details?.meta,
              source: { type: "path", value: path },
            },
          },
        };
      });
    },
  });
}
