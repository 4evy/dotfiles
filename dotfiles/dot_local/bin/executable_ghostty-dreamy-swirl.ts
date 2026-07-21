#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CANVAS = { height: 1080, width: 1920 } as const;
const DEFAULT_SEED = "25b38848";
const OUTPUT =
  process.argv[2] ??
  join(homedir(), ".config/ghostty/backgrounds/catppuccin-emoji-corner.png");
const SEED = process.env.GHOSTTY_SWIRL_SEED ?? DEFAULT_SEED;

type Family =
  | "bubble"
  | "flamingo"
  | "flower"
  | "heart"
  | "lotus"
  | "nails"
  | "purse"
  | "ribbon"
  | "sparkle"
  | "tulip"
  | "wing";

type Role = Readonly<{
  angle: number;
  emoji: string;
  family: Family;
  size: number;
}>;

type Point = Role & {
  pointSize: number;
  rotation: number;
  swirl: 0 | 1;
  x: number;
  y: number;
};

type SwirlParameters = Readonly<{
  centerX: number;
  centerY: number;
  inner: number;
  outer: number;
  start: number;
  turns: number;
  yScale: number;
}>;

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(initialSeed: number): () => number {
  let state = initialSeed;
  return (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(hashSeed(SEED));
const between = (minimum: number, maximum: number): number =>
  minimum + random() * (maximum - minimum);
const integer = (minimum: number, maximum: number): number =>
  Math.floor(between(minimum, maximum + 1));

function copies<const T extends Role>(count: number, role: T): T[] {
  return Array.from({ length: count }, () => role);
}

const roles = [
  ...copies(5, { emoji: "🌸", family: "flower", size: 23, angle: 18 }),
  ...copies(4, { emoji: "🎀", family: "ribbon", size: 29, angle: 24 }),
  ...copies(4, { emoji: "🩷", family: "heart", size: 25, angle: 15 }),
  ...copies(3, { emoji: "💗", family: "heart", size: 23, angle: 14 }),
  ...copies(3, { emoji: "🫧", family: "bubble", size: 19, angle: 18 }),
  ...copies(3, { emoji: "✨", family: "sparkle", size: 16, angle: 10 }),
  ...copies(2, { emoji: "🪷", family: "lotus", size: 28, angle: 12 }),
  ...copies(2, { emoji: "🌷", family: "tulip", size: 22, angle: 16 }),
  ...copies(2, { emoji: "🪽", family: "wing", size: 24, angle: 26 }),
  { emoji: "🦩", family: "flamingo", size: 28, angle: 10 },
  { emoji: "👛", family: "purse", size: 25, angle: 14 },
  { emoji: "💅🏻", family: "nails", size: 24, angle: 12 },
] satisfies readonly Role[];

function shuffled<const T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = integer(0, index);
    const currentValue = result[index];
    const otherValue = result[other];
    if (currentValue === undefined || otherValue === undefined) continue;
    result[index] = otherValue;
    result[other] = currentValue;
  }
  return result;
}

// Shuffle without allowing long runs of one visual family.
function variedOrder<const T extends Role>(values: readonly T[]): T[] {
  const remaining = shuffled(values);
  const result: T[] = [];
  while (remaining.length > 0) {
    const recent = new Set(result.slice(-2).map(({ family }) => family));
    let choices = remaining
      .map((value, index) => ({ index, value }))
      .filter(({ value }) => !recent.has(value.family));
    if (choices.length === 0) {
      choices = remaining.map((value, index) => ({ index, value }));
    }
    const choice = choices[integer(0, choices.length - 1)];
    if (choice === undefined) throw new Error("failed to choose an emoji role");
    result.push(choice.value);
    remaining.splice(choice.index, 1);
  }
  return result;
}

function makeSwirl(
  values: readonly Role[],
  parameters: SwirlParameters,
  swirl: 0 | 1,
): Point[] {
  return values.map((role, index) => {
    const progress = index / Math.max(1, values.length - 1);
    const theta =
      parameters.start +
      parameters.turns * Math.PI * 2 * progress +
      between(-0.035, 0.035);
    const radius =
      parameters.outer +
      (parameters.inner - parameters.outer) * progress +
      between(-12, 12);
    return {
      ...role,
      pointSize: role.size + integer(-2, 2),
      rotation: integer(-role.angle, role.angle),
      swirl,
      x: parameters.centerX + radius * Math.cos(theta),
      y: parameters.centerY + parameters.yScale * radius * Math.sin(theta),
    };
  });
}

const ordered = variedOrder(roles);
const firstCount = 17;
const points: Point[] = [
  ...makeSwirl(
    ordered.slice(0, firstCount),
    {
      centerX: between(1245, 1310),
      centerY: between(805, 840),
      inner: between(84, 102),
      outer: between(365, 405),
      start: between(2.48, 2.82),
      turns: between(1.36, 1.53),
      yScale: between(0.74, 0.82),
    },
    0,
  ),
  ...makeSwirl(
    ordered.slice(firstCount),
    {
      centerX: between(1625, 1680),
      centerY: between(805, 840),
      inner: between(80, 98),
      outer: between(235, 270),
      start: between(0.25, 0.53),
      turns: between(1.1, 1.28),
      yScale: between(0.74, 0.82),
    },
    1,
  ),
];

const proxyMultipliers = {
  bubble: 1.35,
  flamingo: 1.2,
  ribbon: 1.2,
  wing: 1.2,
} satisfies Partial<Record<Family, number>>;

function proxyRadius(point: Point): number {
  const multiplier =
    point.family in proxyMultipliers
      ? proxyMultipliers[point.family as keyof typeof proxyMultipliers]
      : undefined;
  return point.pointSize * (multiplier ?? 1.05);
}

// Resolve cross-swirl collisions while retaining both currents. Same-family
// objects receive additional breathing room.
for (let iteration = 0; iteration < 120; iteration += 1) {
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const a = points[left];
      const b = points[right];
      if (a === undefined || b === undefined) continue;

      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = Math.hypot(dx, dy);
      const minimum =
        proxyRadius(a) + proxyRadius(b) + (a.family === b.family ? 28 : 10);
      if (distance >= minimum) continue;
      if (distance < 0.001) {
        dx = between(-1, 1);
        dy = between(-1, 1);
        distance = Math.hypot(dx, dy);
      }
      const push = (minimum - distance) * 0.52;
      const unitX = dx / distance;
      const unitY = dy / distance;
      a.x -= unitX * push;
      a.y -= unitY * push;
      b.x += unitX * push;
      b.y += unitY * push;
    }
  }

  for (const point of points) {
    point.x = Math.max(850, Math.min(1890, point.x));
    point.y = Math.max(545, Math.min(1025, point.y));
  }
}

const magick = spawnSync("magick", ["-version"], { stdio: "ignore" });
if (magick.error !== undefined || magick.status !== 0) {
  console.error(
    "ghostty dreamy swirl: ImageMagick is not installed; skipping generation",
  );
  process.exit(0);
}

const useNativeMacEmoji = process.platform === "darwin";
if (useNativeMacEmoji) {
  const pangoView = spawnSync("pango-view", ["--version"], { stdio: "ignore" });
  if (pangoView.error !== undefined || pangoView.status !== 0) {
    throw new Error(
      "ghostty dreamy swirl: pango-view is required for color emoji on macOS",
    );
  }
}

function runCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    throw (
      result.error ??
      new Error(`${command} exited with status ${result.status ?? "unknown"}`)
    );
  }
}

const runMagick = (args: readonly string[]): void => runCommand("magick", args);

const signed = (value: number): string =>
  value >= 0 ? `+${value}` : `${value}`;
mkdirSync(dirname(OUTPUT), { recursive: true });
const temporary = join(dirname(OUTPUT), `.dreamy-swirl.${process.pid}.png`);
const work = mkdtempSync(join(tmpdir(), "ghostty-dreamy-swirl."));
let canvas = join(work, "canvas.png");

try {
  runMagick([
    "-size",
    `${CANVAS.width}x${CANVAS.height}`,
    "xc:rgba(0,0,0,0)",
    "-colorspace",
    "sRGB",
    `PNG32:${canvas}`,
  ]);

  for (const [index, point] of points.entries()) {
    const sprite = join(work, `sprite-${index}.png`);
    const next = join(work, `canvas-${index}.png`);
    const offsetX = Math.round(point.x - CANVAS.width / 2);
    const offsetY = Math.round(point.y - CANVAS.height / 2);

    if (useNativeMacEmoji) {
      const unrotated = join(work, `unrotated-${index}.png`);
      runCommand("pango-view", [
        "--no-display",
        `--text=${point.emoji}`,
        `--font=Noto Color Emoji ${point.pointSize}`,
        "--background=transparent",
        // Prevent accents and rotated color glyphs from touching Pango's edge.
        "--margin=8",
        `--output=${unrotated}`,
      ]);
      runMagick([
        unrotated,
        "-background",
        "none",
        "-rotate",
        `${point.rotation}`,
        "-trim",
        "+repage",
        `PNG32:${sprite}`,
      ]);
    } else {
      runMagick([
        "-background",
        "none",
        `pango:<span font_family="Noto Color Emoji" font_size="${point.pointSize}pt">${point.emoji}</span>`,
        "-background",
        "none",
        "-rotate",
        `${point.rotation}`,
        "-trim",
        "+repage",
        `PNG32:${sprite}`,
      ]);
    }
    runMagick([
      canvas,
      sprite,
      "-gravity",
      "center",
      "-geometry",
      `${signed(offsetX)}${signed(offsetY)}`,
      "-composite",
      `PNG32:${next}`,
    ]);
    canvas = next;
  }

  runMagick([canvas, "-strip", `PNG32:${temporary}`]);
  chmodSync(temporary, 0o644);
  renameSync(temporary, OUTPUT);
} catch (error: unknown) {
  rmSync(temporary, { force: true });
  throw error;
} finally {
  rmSync(work, { force: true, recursive: true });
}

console.log(`ghostty dreamy swirl: generated ${OUTPUT} (seed ${SEED})`);
