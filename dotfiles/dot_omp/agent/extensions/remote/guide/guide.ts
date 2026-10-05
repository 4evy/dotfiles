import { userInfo } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connections } from "../connections/state";
import { connectionState } from "../connections/state";
import { configuredHosts } from "../connections/target";
import type { ConnectionState } from "../connections/types";
import { discoverTailscaleHosts } from "../tailscale";
import { createGuideParameters } from "./schemas";
import { TOPICS } from "./topics";

export function registerGuide(api: ExtensionAPI, { connections }: Connections) {
  const { guideParameters } = createGuideParameters(api);
  const username = userInfo().username;
  api.on("before_agent_start", (event, ctx) => ({
    systemPrompt: [
      ...event.systemPrompt,
      `Use managed SSH tools for shell commands, including on this machine.
Load remote topic connect; for same-machine work use ${JSON.stringify({
        target: "127.0.0.1",
        username,
        cwd: ctx.cwd,
      })}, then remote_run with an explicit cwd.
Use remote_job for job output/input/control, remote_sudo for privileged commands,
and remote_read/remote_write/remote_edit/remote_delete for remote files.
Local file tools remain available for local files.
Linux and macOS support jobs; desktop is Linux-only.
Report missing SSH or unsupported job hosts; do not silently fall back.
Local shell is allowed for SSH diagnosis/setup or OMP-inherited environment needs.
Never enable SSH, change authentication or weaken host-key checks without approval.
SSH has a separate environment; choose Bash or Zsh and load envFiles/env when needed.`,
    ],
  }));
  api.registerTool({
    name: "remote",
    label: "Remote guide",
    description:
      "Guidance for managed SSH shell commands, jobs, sudo and desktop access on this machine or another host. Choose a topic; this guide does not connect.",
    parameters: guideParameters,
    loadMode: "essential",
    approval: "read",
    async execute(_id, input, signal, _update, ctx) {
      const { topic = "start" } = guideParameters.parse(input);
      const enabled = new Set(api.getActiveTools());
      function route(tool: string): string {
        return enabled.has(tool)
          ? `Call ${tool} if exposed; otherwise read xd://${
              tool
            } for its schema and write JSON arguments to xd://${tool}.`
          : `${tool} requires an explicit tool grant; it is not enabled for this agent.`;
      }
      const savedConnections = [...connections.values()];
      const profiles = savedConnections.map((connection) => ({
        id: connection.id,
        host: connection.target.host,
        username: connection.target.username,
        os: connection.info.os,
        arch: connection.arch,
        cwd: connection.cwd,
        shells: {
          bash: connection.bash,
          ...(connection.zsh ? { zsh: connection.zsh } : {}),
        },
        controlPath: connection.controlPath,
        timeoutAvailable: Boolean(connection.timeout),
        ...(connection.helper ? { helper: connection.helper } : {}),
        ...(connection.fileRoot ? { files: connection.fileRoot } : {}),
      }));
      const localConnection = { target: "127.0.0.1", username, cwd: ctx.cwd };
      const guidance = [
        ...TOPICS[topic].tools.map(route),
        TOPICS[topic].text,
        ...(topic === "start" || topic === "connect"
          ? [
              `Same-machine remote_connect arguments: ${JSON.stringify(localConnection)}`,
            ]
          : []),
      ].join("\n");
      let hosts: unknown;
      const tailscale =
        topic === "connect" ? await discoverTailscaleHosts() : undefined;
      let masters: (ConnectionState & { id: string })[] | undefined;
      if (topic === "connect") {
        const configured = await configuredHosts(ctx.cwd);
        masters = [];
        for (const connection of savedConnections) {
          masters.push({
            id: connection.id,
            ...(await connectionState(connection, signal)),
          });
        }
        hosts = {
          hosts: configured.hosts.map((host) => ({
            name: host.name,
            host: host.host,
            username: host.username,
            port: host.port,
            description: host.description,
          })),
          warnings: configured.warnings,
        };
      }
      return {
        content: [
          { type: "text", text: guidance },
          ...(profiles.length
            ? [
                {
                  type: "text" as const,
                  text: `Saved connections:\n${JSON.stringify(profiles, null, 2)}`,
                },
              ]
            : []),
          ...(hosts
            ? [
                {
                  type: "text" as const,
                  text: `Configured hosts:\n${JSON.stringify(hosts, null, 2)}`,
                },
              ]
            : []),
          ...(tailscale
            ? [
                {
                  type: "text" as const,
                  text: `Tailscale discovery:\n${JSON.stringify(tailscale, null, 2)}`,
                },
              ]
            : []),
          ...(masters
            ? [
                {
                  type: "text" as const,
                  text: `SSH masters:\n${JSON.stringify(masters, null, 2)}`,
                },
              ]
            : []),
        ],
        details: {
          topic,
          connections: profiles,
          ...(topic === "start" || topic === "connect" ? { localConnection } : {}),
          ...(hosts ? { hosts } : {}),
          ...(tailscale ? { tailscale } : {}),
          ...(masters ? { masters } : {}),
        },
      };
    },
  });
}
