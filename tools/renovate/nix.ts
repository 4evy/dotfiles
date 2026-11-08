import { output, run } from "@dotfiles/core/commands";
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
      package = builtins.getAttr ${JSON.stringify(name)} flake.packages.\${system};
    in pkgs.writeShellScript "update-package" (
      pkgs.lib.escapeShellArgs (pkgs.lib.toList package.updateScript) + " \\"$@\\""
    )
  `;
  const script = yield* output(
    [
      "nix",
      "build",
      "--impure",
      "--no-link",
      "--print-out-paths",
      "--expr",
      expression,
    ],
    { cwd: root },
  );
  if (!script.startsWith("/nix/store/") || script.includes("\n"))
    return yield* Effect.fail(new DotfilesError(`Invalid updater path for ${name}`));
  yield* run([script, ...args], { cwd: root, capture: true });
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
