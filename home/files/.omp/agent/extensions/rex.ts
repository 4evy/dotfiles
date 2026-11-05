import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// OMP owns OSC 7501 status reporting, this extension only supplies Rex context
export default function rex(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const session = process.env.REX_SESSION;
    const block = process.env.REX_BLOCK;
    const bin = process.env.REX_BIN_DIR;
    if (!session || !block || !bin) return;

    return {
      systemPrompt: [
        ...event.systemPrompt,
        [
          "This agent is running in a Rex terminal",
          `Rex context: ${JSON.stringify({
            server: process.env.REX_SERVER,
            session,
            block,
            bin,
          })}`,
          'Use "$REX_BIN_DIR/rex" so the CLI matches this terminal’s server',
          "If a command tool omits REX_* variables, forward this context through its env option or use the absolute CLI path with explicit server, session, and block options",
          "Use the shared rex skill for terminal operations",
          "Target this agent’s session and block unless another target is requested",
          "Do not rename the Rex session unless explicitly asked",
        ].join("\n"),
      ],
    };
  });
}
