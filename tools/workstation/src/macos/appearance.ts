import { run } from "@dotfiles/core/commands";
import { color, palettes, rgbComponents } from "@dotfiles/workstation/theme";
import { Effect } from "effect";
import { applyIconTint } from "./tint.ts";

export const applyAppearance = Effect.fn("applyAppearance")(function* () {
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
    yield* run(["defaults", "write", ...args]);
  yield* applyIconTint(accent);
});
