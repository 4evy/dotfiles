import {
  DAEMON_PTY_COLUMNS,
  DAEMON_PTY_ROWS,
  parseDaemonTerminalSize,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { DaemonSnapshot, DaemonTerminalSize } from "@oh-my-pi/pi-tui/tools/daemon";

const KEY_BYTES: Readonly<Record<string, string>> = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  delete: "\x1b[3~",
  insert: "\x1b[2~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
  space: " ",
};

export const TERMINAL_KEYS =
  "Enter, Tab, Escape (Esc/ESC), Backspace, Space, Up/Down/Left/Right, " +
  "Home/End, PageUp/PageDown (PgUp/PgDn), Insert/Delete (Ins/Del), F1–F12; " +
  "Ctrl+A–Z, Ctrl+Space, Ctrl+[, Ctrl+\\, Ctrl+], Ctrl+^, Ctrl+_, Ctrl+?; " +
  "Shift+Tab and Shift/Ctrl/Alt combinations on navigation/function keys; " +
  "Alt+printable ASCII characters";

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  ins: "insert",
  del: "delete",
  bs: "backspace",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

const KEY_NAMES = Object.keys(KEY_BYTES);
const KEY_MODIFIERS = ["ctrl", "alt", "shift"];

function keyDistance(name: string, candidate: string): number {
  let row = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  for (let left = 0; left < name.length; left++) {
    const next = [left + 1];
    for (let right = 0; right < candidate.length; right++)
      next.push(
        Math.min(
          (next[right] ?? 0) + 1,
          (row[right + 1] ?? 0) + 1,
          (row[right] ?? 0) + (name[left] === candidate[right] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[candidate.length] ?? name.length;
}

function unknownKey(key: string, name: string): never {
  const suggested = KEY_NAMES.reduce((best, next) =>
    keyDistance(name, next) < keyDistance(name, best) ? next : best,
  );
  throw new Error(
    `Unknown terminal key: ${key}. ${
      keyDistance(name, suggested) <= 3 ? `Did you mean ${suggested}? ` : ""
    }Supported keys: ${TERMINAL_KEYS}`,
  );
}

export function keyBytes(keys: string[] | undefined, terminalText?: string): string {
  if (!Array.isArray(keys) || keys.length === 0)
    throw new Error("keys requires a nonempty array of named keys");
  let applicationCursor = false;
  for (const match of (terminalText ?? "").matchAll(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: VT escape sequences set application cursor mode
    /\x1bc|\x1b\[\?([0-9;]+)([hl])/gu,
  )) {
    if (match[0] === "\x1bc") applicationCursor = false;
    else if (match[1]?.split(";").includes("1")) applicationCursor = match[2] === "h";
  }
  return keys
    .map((key) => {
      if (typeof key !== "string") throw new Error("keys must contain named keys");
      const parts = (key.endsWith("++") ? key.slice(0, -1) : key).split("+");
      const literal = key.endsWith("++") ? "+" : (parts.pop() ?? "");
      if (key.endsWith("++")) parts.pop();
      const base = literal.toLowerCase();
      const name = Object.hasOwn(KEY_ALIASES, base)
        ? (KEY_ALIASES[base] ?? base)
        : base;
      const modifierNames = parts.map((part) => part.toLowerCase());
      const modifiers = new Set(modifierNames);
      if (
        modifiers.size !== modifierNames.length ||
        modifierNames.some((part) => !KEY_MODIFIERS.includes(part))
      )
        unknownKey(key, name);
      const ctrl = modifiers.has("ctrl");
      const alt = modifiers.has("alt");
      const shift = modifiers.has("shift");
      if (ctrl && !shift && /^(?:[a-z@[\]\\^_?]|space)$/u.test(name)) {
        const code =
          name === "space" || name === "@"
            ? 0
            : name === "?"
              ? 127
              : name.toUpperCase().charCodeAt(0) & 31;
        return `${alt ? "\x1b" : ""}${String.fromCharCode(code)}`;
      }
      const bytes = Object.hasOwn(KEY_BYTES, name) ? KEY_BYTES[name] : undefined;
      if (bytes === undefined) {
        if (alt && !ctrl && !shift && /^[\x20-\x7e]$/u.test(base))
          return `\x1b${literal}`;
        unknownKey(key, name);
      }
      if (modifiers.size === 0)
        return applicationCursor && /^(up|down|left|right|home|end)$/u.test(name)
          ? bytes.replace("[", "O")
          : bytes;
      if (shift && !ctrl && !alt && name === "tab") return "\x1b[Z";
      const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
      if (/^(up|down|left|right|home|end|f[1-4])$/u.test(name))
        return `\x1b[1;${modifier}${bytes.at(-1)}`;
      if (/^(pageup|pagedown|insert|delete|f(?:[5-9]|1[0-2]))$/u.test(name))
        return bytes.replace("~", `;${modifier}~`);
      if (alt && !ctrl && !shift) return `\x1b${bytes}`;
      return unknownKey(key, name);
    })
    .join("");
}

export function terminalSize(daemon: DaemonSnapshot): DaemonTerminalSize {
  const size = daemon.terminalSize;
  if (!size) return { columns: DAEMON_PTY_COLUMNS, rows: DAEMON_PTY_ROWS };
  return parseDaemonTerminalSize(size);
}
