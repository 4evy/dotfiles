import { DotfilesError } from "@dotfiles/core/errors";
import document from "@dotfiles/home/palette";
import { Schema } from "effect";

const paletteSchema = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isPattern(/^#[\da-fA-F]{6}$/)),
);
const paletteDocumentSchema = Schema.Struct({
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
