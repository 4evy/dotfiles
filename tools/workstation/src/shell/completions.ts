import { dirname, join } from "node:path";
import { run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { ensureDirectory, writeIfChanged } from "@dotfiles/core/files";
import generatorData from "@dotfiles/home/generators";
import { GeneratorsSchema } from "@dotfiles/home/schema";
import { Console, Effect, FileSystem, Schema } from "effect";

function completionTarget(
  target: string,
  cache: string,
  data: string,
): string | undefined {
  if (target.startsWith(".cache/zsh/completions/"))
    return join(cache, target.slice(".cache/".length));
  if (target.startsWith(".local/share/bash-completion/completions/"))
    return join(data, target.slice(".local/share/".length));
  return undefined;
}

const generateCompletion = Effect.fn("generateCompletion")(function* (
  generator: (typeof GeneratorsSchema.Type)[number],
  target: string,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const command = generator.requireCommand ?? generator.command[0] ?? "";
  if (!(yield* Effect.sync(() => Bun.which(command)))) {
    const existing = yield* fs.lstat(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    );
    if (existing?.type === "File" || existing?.type === "SymbolicLink")
      yield* fs.remove(target);
    return;
  }
  yield* ensureDirectory(dirname(target));
  const result = yield* run(
    generator.command.map((part) => part.replaceAll("@HOME@", home)),
    { check: false, capture: true },
  );
  if (result.code !== 0)
    yield* Console.log(
      `Failed to generate shell integration for ${generator.requireCommand ?? generator.command[0]}`,
    );
  else yield* writeIfChanged(target, result.stdout);
});

export const shellCompletions = Effect.fn("shellCompletions")(function* () {
  const home = process.env.HJEM_HOME_DIR;
  if (!home) return yield* Effect.fail(new DotfilesError("HJEM_HOME_DIR is required"));
  const cache = process.env.XDG_CACHE_HOME ?? join(home, ".cache");
  const data = process.env.XDG_DATA_HOME ?? join(home, ".local/share");
  const generators = yield* Schema.decodeUnknownEffect(GeneratorsSchema)(generatorData);
  for (const generator of generators) {
    if (generator.systems && !generator.systems.includes(process.platform)) continue;
    const target = completionTarget(generator.target, cache, data);
    if (target) yield* generateCompletion(generator, target, home);
  }
});
