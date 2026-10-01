import { chmod, realpath, rename, rm, stat } from "node:fs/promises";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

// Keep quota accounting and warning colors in used-percent units; only change
// the two footer formatters (ANSI and native) to explicitly labeled allowance left
export function patchQuotaDisplay(source: string): string {
  const names = new Set(
    [
      ...source.matchAll(
        /(?<![\w$])([\w$]+)\((?:[\w$]+,)?"7d",[\w$]+\.sevenDay\.percent,/g,
      ),
    ]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
  if (names.size !== 2) {
    throw new Error("Unrecognized OMP quota renderers; refusing to patch");
  }

  const edits: { start: number; end: number; text: string }[] = [];
  for (const name of names) {
    const declaration = new RegExp(
      `function ${RegExp.escape(name)}\\(([^)]*)\\)\\{`,
      "g",
    );
    const matches = [...source.matchAll(declaration)];
    const match = matches[0];
    if (matches.length !== 1 || !match?.[1]) {
      throw new Error(`Unrecognized OMP quota formatter: ${name}`);
    }
    const start = match.index;
    const scanner = createScanner(true, undefined, match[0]);
    if (
      scanner.scan() !== SyntaxKind.FunctionKeyword ||
      scanner.scan() !== SyntaxKind.Identifier ||
      scanner.scan() !== SyntaxKind.OpenParenToken
    ) {
      throw new Error(`Invalid OMP quota declaration: ${name}`);
    }
    const params = match[1].split(",");
    if (params.length !== 5 && params.length !== 6) {
      throw new Error(`Unrecognized OMP quota parameters: ${name}`);
    }
    const percent = params[params.length === 6 ? 2 : 1];
    const end = source.indexOf("}function ", start) + 1;
    if (!percent || end <= start || end - start > 1500) {
      throw new Error(`Unrecognized OMP quota function boundary: ${name}`);
    }
    const body = source.slice(start, end);
    const rounding = `Math.floor(${percent}):Math.round(${percent})`;
    const remaining = `Math.floor(100-${percent}):Math.round(100-${percent})`;
    if (body.includes(remaining) && body.includes("% left`")) continue;
    if (!body.includes(rounding) || !body.includes("}%`")) {
      throw new Error(`Unrecognized OMP quota percentage formatting: ${name}`);
    }
    edits.push({
      start,
      end,
      text: body.replace(rounding, remaining).replace("}%`", "}% left`"),
    });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

// Recolor the existing procedural gradient without changing its animation,
// projection, shine sweep, or glyph geometry
export function patchTransLogo(source: string): string {
  for (const [before, after] of [
    [
      "[[248,79,204],[147,98,244],[0,219,228]]",
      "[[91,206,250],[245,169,184],[255,255,255],[245,169,184],[91,206,250]]",
    ],
    ["[206,170,134,99,69,74,44]", "[81,217,231,217,81]"],
  ]) {
    if (!before || !after) throw new Error("Invalid OMP palette rewrite");
    const originalCount = source.split(before).length - 1;
    const patchedCount = source.split(after).length - 1;
    if (originalCount === 0 && patchedCount === 1) continue;
    if (originalCount !== 1 || patchedCount !== 0) {
      throw new Error("Unrecognized OMP logo palette; refusing to patch");
    }
    source = source.replace(before, after);
  }
  return source;
}

if (import.meta.main) {
  const executable = Bun.argv[2];
  if (!executable) throw new Error("Usage: patch-omp-ui.ts OMP_EXECUTABLE");
  const target = await realpath(executable);
  const source = await Bun.file(target).text();
  const patched = patchTransLogo(patchQuotaDisplay(source));
  if (patched !== source) {
    const temporary = `${target}.ui-${process.pid}`;
    try {
      await Bun.write(temporary, patched);
      await chmod(temporary, (await stat(target)).mode);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
