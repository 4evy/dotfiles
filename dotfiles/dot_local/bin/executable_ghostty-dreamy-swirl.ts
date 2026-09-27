#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Ghostty scales and crops this centered texture separately for every pane
// https://ghostty.org/docs/config/reference#background-image-fit
// Near-native pixels keep glyph edges crisp in a typical wide window
const IMAGE_SIZE = {
  width: 2048,
  height: (2048 * 9) / 16,
} as const;
const BASE_FONT_SIZE = Math.round(IMAGE_SIZE.width / 60);
const MEDIUM_FONT_SIZE = Math.round((BASE_FONT_SIZE * 11) / 12);
const SPARKLE_FONT_SIZE = Math.round((BASE_FONT_SIZE * 5) / 8);
const FONT_SIZE_JITTER = Math.round(BASE_FONT_SIZE / 12);
const MAX_ROTATION_DEGREES = 15;
const DEFAULT_SEED = "25b38848";
// Some color glyphs draw beyond Pango's logical cell before rotation
const SPRITE_MARGIN_PIXELS = BASE_FONT_SIZE;
const EDGE_MARGIN = BASE_FONT_SIZE * 2;
const CANDIDATES_PER_PLACED_EMOJI = 4;
const OUTPUT =
  process.argv[2] ??
  join(homedir(), ".config/ghostty/backgrounds/t3-chat-emoji-scatter.png");
const SEED = process.env.GHOSTTY_SWIRL_SEED ?? DEFAULT_SEED;

// Smaller hearts, rainbows, and sparkles leave more space between large flags
const ROLE_STYLE = {
  flag: {
    fontSize: BASE_FONT_SIZE,
    maxRotationDegrees: MAX_ROTATION_DEGREES - 1,
  },
  rainbow: {
    fontSize: MEDIUM_FONT_SIZE,
    maxRotationDegrees: MAX_ROTATION_DEGREES - 1,
  },
  heart: {
    fontSize: MEDIUM_FONT_SIZE,
    maxRotationDegrees: MAX_ROTATION_DEGREES,
  },
  sparkle: {
    fontSize: SPARKLE_FONT_SIZE,
    maxRotationDegrees: (MAX_ROTATION_DEGREES * 2) / 3,
  },
} as const;

type Family = keyof typeof ROLE_STYLE;

type Role = Readonly<{
  emoji: string;
  family: Family;
}>;

type Point = Role & {
  renderedFontSize: number;
  rotationDegrees: number;
  x: number;
  y: number;
};

// FNV-1a-style mixing over Unicode code points, not standard FNV byte input
// https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Keep this generator's constants together so a seed keeps the same artwork
// https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
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

const ROLE_COUNTS = [
  { count: 4, emoji: "🏳️‍🌈", family: "flag" },
  { count: 4, emoji: "🏳️‍⚧️", family: "flag" },
  { count: 3, emoji: "🌈", family: "rainbow" },
  { count: 4, emoji: "🩷", family: "heart" },
  { count: 4, emoji: "💜", family: "heart" },
  { count: 4, emoji: "💙", family: "heart" },
  { count: 3, emoji: "🩵", family: "heart" },
  { count: 2, emoji: "🤍", family: "heart" },
  { count: 3, emoji: "✨", family: "sparkle" },
] as const satisfies readonly { count: number; emoji: string; family: Family }[];

const roles: Role[] = ROLE_COUNTS.flatMap(({ count, ...role }) =>
  Array.from({ length: count }, () => role),
);

// Fisher-Yates uses one uniformly chosen remaining index per swap
// https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle
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

// Mitchell's best-candidate sampling chooses the most isolated of several
// random candidates for each point, without putting the emojis on a grid
// https://my.eng.utah.edu/~cs6958/papers/p157-mitchell.pdf
// Wrap distances across the edges so candidates are not pulled to the border
function nearestClearance(candidate: Point, placed: readonly Point[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const point of placed) {
    const absoluteX = Math.abs(candidate.x - point.x);
    const absoluteY = Math.abs(candidate.y - point.y);
    const dx = Math.min(absoluteX, IMAGE_SIZE.width - absoluteX);
    const dy = Math.min(absoluteY, IMAGE_SIZE.height - absoluteY);
    const clearance =
      Math.hypot(dx, dy) - candidate.renderedFontSize - point.renderedFontSize;
    nearest = Math.min(nearest, clearance);
  }
  return nearest;
}

const points: Point[] = [];
for (const role of shuffled(roles)) {
  const style = ROLE_STYLE[role.family];
  const renderedFontSize =
    style.fontSize + integer(-FONT_SIZE_JITTER, FONT_SIZE_JITTER);
  const rotationDegrees = integer(-style.maxRotationDegrees, style.maxRotationDegrees);
  let best: Point | undefined;
  let bestClearance = Number.NEGATIVE_INFINITY;

  // Mitchell grows the candidate count with the number of placed points
  const candidateCount = CANDIDATES_PER_PLACED_EMOJI * (points.length + 1);
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
    const candidate: Point = {
      ...role,
      renderedFontSize,
      rotationDegrees,
      x: between(EDGE_MARGIN, IMAGE_SIZE.width - EDGE_MARGIN),
      y: between(EDGE_MARGIN, IMAGE_SIZE.height - EDGE_MARGIN),
    };
    const clearance = nearestClearance(candidate, points);
    if (clearance > bestClearance) {
      best = candidate;
      bestClearance = clearance;
    }
  }
  if (best === undefined) throw new Error("failed to place an emoji");
  points.push(best);
}

const magick = spawnSync("magick", ["-version"], { stdio: "ignore" });
if (magick.error !== undefined || magick.status !== 0) {
  console.error(
    "ghostty emoji scatter: ImageMagick is not installed; skipping generation",
  );
  process.exit(0);
}

const useNativeMacEmoji = process.platform === "darwin";
if (useNativeMacEmoji) {
  const pangoView = spawnSync("pango-view", ["--version"], { stdio: "ignore" });
  if (pangoView.error !== undefined || pangoView.status !== 0) {
    throw new Error(
      "ghostty emoji scatter: pango-view is required for color emoji on macOS",
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

const signed = (value: number): string => (value >= 0 ? `+${value}` : `${value}`);
mkdirSync(dirname(OUTPUT), { recursive: true });
const work = mkdtempSync(join(dirname(OUTPUT), ".emoji-scatter."));
const temporary = join(work, "output.png");
let canvas = join(work, "canvas.png");

try {
  runMagick([
    "-size",
    `${IMAGE_SIZE.width}x${IMAGE_SIZE.height}`,
    "xc:none",
    "-colorspace",
    "sRGB",
    `PNG32:${canvas}`,
  ]);

  for (const [index, point] of points.entries()) {
    const sprite = join(work, `sprite-${index}.png`);
    const next = join(work, `canvas-${index}.png`);
    const pointSize = Math.max(1, point.renderedFontSize);
    const offsetX = Math.round(point.x - IMAGE_SIZE.width / 2);
    const offsetY = Math.round(point.y - IMAGE_SIZE.height / 2);

    if (useNativeMacEmoji) {
      const unrotated = join(work, `unrotated-${index}.png`);
      runCommand("pango-view", [
        "--no-display",
        `--text=${point.emoji}`,
        `--font=Noto Color Emoji ${pointSize}`,
        "--background=transparent",
        // Prevent accents and rotated color glyphs from touching Pango's edge
        `--margin=${SPRITE_MARGIN_PIXELS}`,
        `--output=${unrotated}`,
      ]);
      runMagick([
        unrotated,
        "-background",
        "none",
        "-rotate",
        `${point.rotationDegrees}`,
        "-trim",
        "+repage",
        `PNG32:${sprite}`,
      ]);
    } else {
      runMagick([
        "-background",
        "none",
        `pango:<span font_family="Noto Color Emoji" font_size="${pointSize}pt">${point.emoji}</span>`,
        "-background",
        "none",
        "-rotate",
        `${point.rotationDegrees}`,
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
} finally {
  rmSync(work, { force: true, recursive: true });
}

console.log(`ghostty emoji scatter: generated ${OUTPUT} (seed ${SEED})`);
