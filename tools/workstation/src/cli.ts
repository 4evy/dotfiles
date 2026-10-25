#!/usr/bin/env bun
import { basename } from "node:path";
import { UsageError } from "../../../lib/typescript/errors.ts";
import { discord } from "./apps/discord/discord.ts";
import { syncEquicordSettings } from "./apps/discord/settings.ts";
import { vscodeIcons } from "./apps/vscode/icons.ts";
import { desktopAudit } from "./desktop/audit.ts";
import { gnomeAccent } from "./desktop/gnome.ts";
import { jjDiff } from "./jj/diff.ts";
import { kmsconRefresh } from "./kmscon/refresh.ts";
import { kmsconTheme } from "./kmscon/theme.ts";
import { applyAppearance } from "./macos/appearance.ts";
import { terminalProfile } from "./macos/terminal.ts";
import { phoneMirror } from "./phone/phone.ts";
import { shellCompletions } from "./shell/completions.ts";

type Action = (args: string[]) => number | Promise<number>;
function noArguments(action: () => void): Action {
  return (args) => {
    if (args.length) throw new UsageError(`Unexpected arguments: ${args.join(" ")}`);
    action();
    return 0;
  };
}
export const commands: Record<string, Action> = {
  "kmscon-theme-config": kmsconTheme,
  "kmscon-refresh": kmsconRefresh,
  "extra-shell-completions": noArguments(shellCompletions),
  "sync-equicord-settings": noArguments(syncEquicordSettings),
  "vscode-catppuccin-custom-icons": noArguments(vscodeIcons),
  "desktop-perf-audit": noArguments(desktopAudit),
  "discord-equicord": discord,
  "gnome-catppuccin-custom-accent": gnomeAccent,
  "jj-diff": jjDiff,
  "macos-catppuccin-custom-appearance": noArguments(applyAppearance),
  "phone-mirror": async (args) => {
    await phoneMirror(args);
    return 0;
  },
  "terminal-catppuccin-custom": noArguments(terminalProfile),
};

function help(command?: string): void {
  if (!command) {
    console.log("Usage: workstation COMMAND [ARGUMENTS...]");
    console.log(Object.keys(commands).join("\n"));
  } else if (command === "phone-mirror")
    console.log(
      "Usage: phone-mirror [--name HOST] [--ip ADDRESS] [--port PORT] [--connect-only] [--render-driver DRIVER] [--sdl-video-driver DRIVER] [-- SCRCPY_ARGUMENTS...]\nEnvironment: PHONE_MIRROR_NAME, PHONE_MIRROR_IP, PHONE_MIRROR_PORT, PHONE_MIRROR_CONNECT_ONLY, PHONE_MIRROR_RENDER_DRIVER, PHONE_MIRROR_SDL_VIDEODRIVER",
    );
  else if (command === "kmscon-theme-config")
    console.log("Usage: kmscon-theme-config PALETTE_JSON OUTPUT_CONFIG");
  else if (command === "kmscon-refresh")
    console.log("Usage: kmscon-refresh CONFIG [--state PATH]");
  else if (command === "jj-diff")
    console.log("Usage: jj-diff patch|stat LEFT RIGHT DOTFILES_REPOSITORY WIDTH");
  else if (command === "discord-equicord")
    console.log("Usage: discord-equicord [--configure-only] [DISCORD_ARGUMENTS...]");
  else if (command === "gnome-catppuccin-custom-accent")
    console.log("Usage: gnome-catppuccin-custom-accent [--once|--watch]");
  else console.log(`Usage: ${command}`);
}

if (import.meta.main) {
  // Bun preserves the invocation name in argv0, not execPath or argv[0]
  const invokedAs = basename(process.argv0);
  const args = process.argv.slice(2);
  const command = Object.hasOwn(commands, invokedAs) ? invokedAs : args.shift();
  try {
    if (!command || command === "--help" || command === "-h") help();
    else {
      const action = Object.hasOwn(commands, command) ? commands[command] : undefined;
      if (!action) throw new UsageError(`Unknown workstation command: ${command}`);
      if (args.includes("--help") || args.includes("-h")) help(command);
      else process.exitCode = (await action(args)) ?? 0;
    }
  } catch (error) {
    console.error(
      `${command ?? "workstation"}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = error instanceof UsageError ? 64 : command === "jj-diff" ? 2 : 1;
  }
}
