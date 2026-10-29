import { run } from "@dotfiles/core/commands";
import { palettes } from "@dotfiles/workstation/theme";
import { Effect } from "effect";
import { nativeTerminal } from "./native.ts";
import policy from "./terminal.json";

export const terminalProfile = Effect.fn("terminalProfile")(function* () {
  if (process.platform !== "darwin") return;
  yield* run(
    [
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
      "-e",
      `(${nativeTerminal.toString()})(${JSON.stringify(palettes)},${JSON.stringify(policy)})`,
    ],
    { outputMode: "discard" },
  );
});
