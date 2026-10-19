import { readFileSync } from "node:fs";
import * as v from "valibot";
import { UsageError } from "../../../../lib/typescript/errors.ts";
import { writeIfChanged } from "../../../../lib/typescript/files.ts";
import { solarDay } from "../lib/solar.ts";
import type { Palette } from "../lib/theme.ts";
import { color, paletteDocumentSchema, rgbComponents } from "../lib/theme.ts";

const roles: Record<string, string> = {
  black: "surface1",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "pink",
  cyan: "sky",
  "light-grey": "subtext0",
  "dark-grey": "surface2",
  "light-red": "red",
  "light-green": "green",
  "light-yellow": "yellow",
  "light-blue": "blue",
  "light-magenta": "pink",
  "light-cyan": "sky",
  white: "subtext1",
  foreground: "terminalForeground",
  background: "terminalBackground",
};
const lightRoles = {
  black: "subtext1",
  white: "surface1",
  "light-grey": "surface2",
  "dark-grey": "subtext0",
};

function coordinate(
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}: ${value}`);
  return result;
}

function theme(now: Date): { name: "light" | "dark"; source: string } {
  const forced = process.env.DOTFILES_KMSCON_THEME;
  if (forced) {
    if (forced !== "light" && forced !== "dark")
      throw new Error(`Unsupported DOTFILES_KMSCON_THEME: ${forced}`);
    return { name: forced, source: "DOTFILES_KMSCON_THEME" };
  }
  let latitude = coordinate("DOTFILES_KMSCON_LATITUDE", -90, 90);
  let longitude = coordinate("DOTFILES_KMSCON_LONGITUDE", -180, 180);
  const location =
    latitude === undefined && longitude === undefined ? "default-sofia" : "env";
  if (location === "default-sofia") {
    latitude = 42.6977;
    longitude = 23.3219;
  }
  if (latitude === undefined || longitude === undefined)
    throw new Error(
      "Set both DOTFILES_KMSCON_LATITUDE and DOTFILES_KMSCON_LONGITUDE for sun-based theme selection",
    );
  const { sunrise, sunset, elevation } = solarDay(now, latitude, longitude);
  if (!sunrise || !sunset)
    return {
      name: elevation >= 0 ? "light" : "dark",
      source: `sun polar latitude=${coordinateText(latitude)} longitude=${coordinateText(longitude)} elevation=${elevation.toFixed(2)}`,
    };
  return {
    name: sunrise <= now && now < sunset ? "light" : "dark",
    source: `sun ${location} latitude=${coordinateText(latitude)} longitude=${coordinateText(longitude)}`,
  };
}

function coordinateText(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function renderKmscon(
  palettes: { light: Palette; dark: Palette },
  now = new Date(),
): string {
  const choice = theme(now);
  const mapping = choice.name === "light" ? { ...roles, ...lightRoles } : roles;
  const lines = [
    "# Managed by dotfiles",
    `# Theme: catppuccin-custom-${choice.name}`,
    `# Theme source: ${choice.source}`,
    "term=kmscon",
    "font-engine=freetype",
    "font-name=Noto Sans Mono",
    "font-size=18",
    "sb-size=10000",
    "mouse",
    "dpms-timeout=600",
    "palette=custom",
  ];
  for (const [option, role] of Object.entries(mapping))
    lines.push(
      `palette-${option}=${rgbComponents(color(palettes[choice.name], role))
        .map((component) => Math.round(component * 255))
        .join(",")}`,
    );
  return `${lines.join("\n")}\n`;
}

export function kmsconTheme(args: string[]): number {
  const [input, output] = args;
  if (args.length !== 2 || !input || !output)
    throw new UsageError("Usage: kmscon-theme-config PALETTE_JSON OUTPUT_CONFIG");
  const palettes = v.parse(
    paletteDocumentSchema,
    JSON.parse(readFileSync(input, "utf8")),
  ).catppuccin_custom;
  writeIfChanged(output, renderKmscon(palettes));
  return 0;
}
