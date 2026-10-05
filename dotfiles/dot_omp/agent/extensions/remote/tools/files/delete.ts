import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { quotePosixPath } from "@oh-my-pi/pi-coding-agent/ssh/utils";
import { ptree } from "@oh-my-pi/pi-utils";
import { remoteArgv } from "../../connections/command";
import type { Connections } from "../../connections/state";
import { resolveRemoteCwd } from "../../connections/target";
import type { FileParameters } from "../schemas/files";

export function registerDeleteTool(
  api: ExtensionAPI,
  { selected }: Connections,
  { deleteParameters }: FileParameters,
) {
  api.registerTool({
    name: "remote_delete",
    label: "Delete remote file",
    description:
      "Delete one remote file or symlink using the saved SSH connection. Refuses directories; a symlink's target is retained. Missing files are errors.",
    parameters: deleteParameters,
    loadMode: "discoverable",
    approval: "write",
    async execute(_id, input, signal) {
      const args = deleteParameters.parse(input);
      const connection = selected(args.connection);
      const path = resolveRemoteCwd(connection, args.path);
      const quoted = quotePosixPath(path);
      const script = `if [ -L ${quoted} ] || [ -f ${quoted} ]; then rm -- ${quoted}; else printf '%s\\n' 'Delete requires an existing file or symlink' >&2; exit 1; fi`;
      const argv = await remoteArgv(connection, script, false);
      signal?.throwIfAborted();
      await ptree.exec(["ssh", ...argv], {
        timeout: 30_000,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [{ type: "text", text: `Deleted ${path}` }],
        details: { connectionId: connection.id, path },
      };
    },
  });
}
