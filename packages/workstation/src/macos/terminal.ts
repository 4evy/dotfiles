import { run } from "../../../../lib/typescript/commands.ts";
import { palettes } from "../lib/theme.ts";
import { nativeTerminal } from "./native.ts";

export function terminalProfile(): void {
  if (process.platform !== "darwin") return;
  run(
    [
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
      "-e",
      `(${nativeTerminal.toString()})(${JSON.stringify(palettes)})`,
    ],
    { outputMode: "discard" },
  );
}
