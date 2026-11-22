import { run } from "@dotfiles/core/commands";
import { Effect } from "effect";
import { root } from "./paths.ts";

export const updatePalette = Effect.fn(function* () {
  // The generator must import the selected palette, not stale node_modules
  yield* run(["bun", "install", "--ignore-scripts", "--frozen-lockfile"], {
    cwd: root,
    capture: true,
  });
  yield* run(["bun", "home/theme/palette/generate.ts"], { cwd: root, capture: true });
});
