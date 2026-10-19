import * as v from "valibot";
import document from "../../../../dotfiles/data/palette/palette.json";
import { DotfilesError } from "../../../../lib/typescript/errors.ts";

const objectInput = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const paletteSchema = v.pipe(
  objectInput,
  v.record(v.string(), v.pipe(v.string(), v.regex(/^#[\da-fA-F]{6}$/))),
);
export const paletteDocumentSchema = v.pipe(
  objectInput,
  v.object({
    catppuccin_custom: v.pipe(
      objectInput,
      v.object({ light: paletteSchema, dark: paletteSchema }),
    ),
  }),
);
export type Palette = v.InferOutput<typeof paletteSchema>;
export const palettes = v.parse(paletteDocumentSchema, document).catppuccin_custom;

export function color(palette: Palette, role: string): string {
  const value = palette[role];
  if (!value) throw new DotfilesError(`Palette has no ${role} color`);
  return value;
}

export function rgbComponents(hex: string): [number, number, number] {
  if (!/^#?[\da-fA-F]{6}$/.test(hex))
    throw new DotfilesError(`Invalid RGB color: ${hex}`);
  const number = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(number >> 16) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}
