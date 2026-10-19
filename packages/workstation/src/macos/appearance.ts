import { run } from "../../../../lib/typescript/commands.ts";
import { color, palettes, rgbComponents } from "../lib/theme.ts";
import { applyIconTint } from "./tint.ts";

export function applyAppearance(): void {
  if (process.platform !== "darwin") return;
  const accent = color(palettes.light, "accent");
  const highlight = rgbComponents(accent)
    .map((value) => value.toFixed(6))
    .join(" ");
  for (const args of [
    ["-g", "AppleAccentColor", "-int", "6"],
    ["-g", "AppleHighlightColor", "-string", `${highlight} Other`],
    ["com.apple.systempreferences", "AppleOtherHighlightColor", "-string", highlight],
  ])
    run(["defaults", "write", ...args]);
  applyIconTint(accent);
}
