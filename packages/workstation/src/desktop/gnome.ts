import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { which } from "../../../../lib/typescript/commands.ts";
import { UsageError } from "../../../../lib/typescript/errors.ts";
import { writeIfChanged } from "../../../../lib/typescript/files.ts";
import { configHome } from "../../../../lib/typescript/paths.ts";
import gtk4 from "../../assets/desktop/gtk/gtk.css.in" with { type: "text" };
import gtk3 from "../../assets/desktop/gtk/legacy.css.in" with { type: "text" };
import { color, palettes } from "../lib/theme.ts";
import { desktopArguments, desktopOutput } from "../linux/desktop.ts";

function apply(scheme: string): void {
  const palette = scheme.includes("prefer-dark") ? palettes.dark : palettes.light;
  for (const [version, template] of [
    [3, gtk3],
    [4, gtk4],
  ] as const) {
    const css = template
      .replaceAll(`\${legacy}`, gtk3)
      .replaceAll(/\$\{(\w+)\}/g, (_, role: string) => color(palette, role));
    writeIfChanged(
      join(configHome(), `gtk-${version}.0/catppuccin-custom-accent.css`),
      css,
    );
  }
}

export async function gnomeAccent(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { once: { type: "boolean" }, watch: { type: "boolean" } },
  });
  if (values.once && values.watch) throw new UsageError("Use either --once or --watch");
  if (!which("gjs")) {
    apply("default");
    return 0;
  }
  if (!values.watch) {
    apply(desktopOutput("theme"));
    return 0;
  }
  const child = Bun.spawn(desktopArguments("watch-theme"), {
    stdout: "pipe",
    stderr: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.on("exit", stop);
  try {
    for await (const line of createInterface({
      input: Readable.fromWeb(child.stdout),
    }))
      apply(line);
    return await child.exited;
  } finally {
    stop();
    process.off("exit", stop);
  }
}
