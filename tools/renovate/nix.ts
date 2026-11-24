import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect } from "effect";
import { root } from "./paths.ts";

// Realize the updater's context without building the application it updates
export const updateNixPackage = Effect.fn(function* (
  name: string,
  args: readonly string[] = [],
) {
  const expression = `
    let
      flake = builtins.getFlake ${JSON.stringify(root)};
      system = builtins.currentSystem;
      pkgs = import flake.inputs.nixpkgs { inherit system; };
      inherit (pkgs) lib writeShellApplication;
      package = builtins.getAttr ${JSON.stringify(name)} flake.packages.\${system};
    in {
      updater = writeShellApplication {
        name = "update-package";
        meta.mainProgram = "update-package";
        text = "exec " + lib.strings.escapeShellArgs (lib.lists.toList package.updateScript) + " \\"$@\\"";
      };
    }
  `;
  yield* run(
    ["nix", "run", "--impure", "--expr", expression, "updater", "--", ...args],
    { cwd: root, capture: true },
  );
});

if (import.meta.main)
  runMain(
    Effect.gen(function* () {
      const [name, ...args] = Bun.argv.slice(2);
      if (!name)
        return yield* Effect.fail(
          new DotfilesError("Usage: bun tools/renovate/nix.ts PACKAGE [ARGUMENTS...]"),
        );
      yield* updateNixPackage(name, args);
    }),
  );
