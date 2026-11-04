import { join } from "node:path";
import { UsageError } from "@dotfiles/core/errors";
import { writeIfChanged } from "@dotfiles/core/files";
import { configHome } from "@dotfiles/core/paths";
import { exitCode } from "@dotfiles/runtime/process";
import gtk3 from "@dotfiles/workstation/assets/gtk3" with { type: "text" };
import gtk4 from "@dotfiles/workstation/assets/gtk4" with { type: "text" };
import { desktopArguments, desktopOutput } from "@dotfiles/workstation/desktop";
import { color, palettes } from "@dotfiles/workstation/theme";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { flag } from "@optique/core/primitives";
import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";

const apply = Effect.fn("gnomeAccent.apply")(function* (scheme: string) {
  const palette = scheme.includes("prefer-dark") ? palettes.dark : palettes.light;
  for (const [version, template] of [
    [3, gtk3],
    [4, gtk4],
  ] as const) {
    const css = template
      .replaceAll(`\${legacy}`, gtk3)
      .replaceAll(/\$\{(\w+)\}/g, (_, role: string) => color(palette, role));
    yield* writeIfChanged(
      join(yield* configHome(), `gtk-${version}.0/catppuccin-custom-accent.css`),
      css,
    );
  }
});

export const gnomeAccent = Effect.fn("gnomeAccent")(function* (args: string[]) {
  const parsed = parseSync(
    object({
      once: map(multiple(flag("--once")), (values) => values.length > 0),
      watch: map(multiple(flag("--watch")), (values) => values.length > 0),
    }),
    args,
  );
  if (!parsed.success)
    return yield* Effect.fail(new UsageError(formatMessage(parsed.error)));
  const values = parsed.value;
  if (values.once && values.watch)
    return yield* Effect.fail(new UsageError("Use either --once or --watch"));
  if (!(yield* Effect.sync(() => Bun.which("gjs")))) {
    yield* apply("default");
    return 0;
  }
  if (!values.watch) {
    yield* apply(yield* desktopOutput("theme"));
    return 0;
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const [command, ...arguments_] = desktopArguments("watch-theme");
      const child = yield* ChildProcess.make(command, arguments_, {
        stdin: "inherit",
        detached: false,
        stdout: "pipe",
        stderr: "inherit",
      });
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(apply),
      );
      return Number(yield* exitCode(child));
    }),
  );
});
