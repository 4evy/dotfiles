import { DotfilesError } from "@dotfiles/core/errors";
import document from "@dotfiles/home/palette";
import { Schema } from "effect";

const HEX_RADIX = 16;
const RGB_CHANNEL_MAX = 0xff;
const RED_CHANNEL_SHIFT = 16;
const GREEN_CHANNEL_SHIFT = 8;

const paletteSchema = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isPattern(/^#[\da-fA-F]{6}$/)),
);
export const paletteDocumentSchema = Schema.Struct({
  catppuccin_custom: Schema.Struct({
    light: paletteSchema,
    dark: paletteSchema,
  }),
});
export type Palette = typeof paletteSchema.Type;
export const palettes =
  Schema.decodeUnknownSync(paletteDocumentSchema)(document).catppuccin_custom;

export function color(palette: Palette, role: string): string {
  const value = palette[role];
  if (!value) throw new DotfilesError(`Palette has no ${role} color`);
  return value;
}

export function rgbComponents(hex: string): [number, number, number] {
  if (!/^#?[\da-fA-F]{6}$/.test(hex))
    throw new DotfilesError(`Invalid RGB color: ${hex}`);
  const number = Number.parseInt(hex.replace(/^#/, ""), HEX_RADIX);
  return [
    (number >> RED_CHANNEL_SHIFT) / RGB_CHANNEL_MAX,
    ((number >> GREEN_CHANNEL_SHIFT) & RGB_CHANNEL_MAX) / RGB_CHANNEL_MAX,
    (number & RGB_CHANNEL_MAX) / RGB_CHANNEL_MAX,
  ];
}
