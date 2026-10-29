import { UsageError } from "@dotfiles/core/errors";
import type { RuntimeServices } from "@dotfiles/core/runtime";
import type { Scope } from "effect";
import { Effect } from "effect";
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
import { phoneEnvironment, phoneUsage } from "./phone/config.ts";
import { phoneMirror } from "./phone/phone.ts";
import { shellCompletions } from "./shell/completions.ts";

type Action = (
  args: string[],
) => Effect.Effect<number, unknown, RuntimeServices | Scope.Scope>;
interface Command {
  run: Action;
  usage: string;
  environment: readonly string[];
}
function noArguments<E, R>(action: () => Effect.Effect<void, E, R>) {
  return (args: string[]) =>
    args.length
      ? Effect.fail(new UsageError(`Unexpected arguments: ${args.join(" ")}`))
      : action().pipe(Effect.as(0));
}
export const commands = {
  "kmscon-theme-config": {
    run: kmsconTheme,
    usage: "PALETTE_JSON OUTPUT_CONFIG",
    environment: [
      "DOTFILES_KMSCON_THEME",
      "DOTFILES_KMSCON_LATITUDE",
      "DOTFILES_KMSCON_LONGITUDE",
    ],
  },
  "kmscon-refresh": {
    run: kmsconRefresh,
    usage: "CONFIG [--state PATH]",
    environment: [],
  },
  "extra-shell-completions": {
    run: noArguments(shellCompletions),
    usage: "",
    environment: ["HJEM_HOME_DIR", "XDG_CACHE_HOME", "XDG_DATA_HOME"],
  },
  "sync-equicord-settings": {
    run: noArguments(syncEquicordSettings),
    usage: "",
    environment: [],
  },
  "vscode-catppuccin-custom-icons": {
    run: noArguments(vscodeIcons),
    usage: "",
    environment: [],
  },
  "desktop-perf-audit": { run: noArguments(desktopAudit), usage: "", environment: [] },
  "discord-equicord": {
    run: discord,
    usage: "[--configure-only] [DISCORD_ARGUMENTS...]",
    environment: [],
  },
  "gnome-catppuccin-custom-accent": {
    run: gnomeAccent,
    usage: "[--once|--watch]",
    environment: [],
  },
  "jj-diff": {
    run: jjDiff,
    usage: "patch|stat LEFT RIGHT DOTFILES_REPOSITORY WIDTH",
    environment: [],
  },
  "macos-catppuccin-custom-appearance": {
    run: noArguments(applyAppearance),
    usage: "",
    environment: [],
  },
  "phone-mirror": {
    run: phoneMirror,
    usage: phoneUsage,
    environment: phoneEnvironment,
  },
  "terminal-catppuccin-custom": {
    run: noArguments(terminalProfile),
    usage: "",
    environment: [],
  },
} satisfies Record<string, Command>;
export type CommandName = keyof typeof commands;
export const commandNames = Object.keys(commands) as CommandName[];
