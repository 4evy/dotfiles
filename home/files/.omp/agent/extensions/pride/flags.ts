import { getTerminalBackgroundColor } from "@oh-my-pi/pi-tui/terminal-capabilities";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { bgAnsi, fgAnsi } from "@oh-my-pi/pi-tui/theme/color";

type Rows = readonly [string, string, string, string];
type WaveRows = readonly [string[], string[], string[], string[]];
type Pixels = readonly [Rows, Rows, Rows];
export const FULL_TURN = 2 * Math.PI;
export const FLAG_PHASE_SPACING = 1.2;
export const MOTION = {
  idle: { strength: 0.65, periodSeconds: 7 },
  waiting: { strength: 0.95, periodSeconds: 3.5 },
  streaming: { strength: 1.35, periodSeconds: 1.4 },
  working: { strength: 1.45, periodSeconds: 1 },
} as const;
export type Activity = keyof typeof MOTION;
export const TWINKLE_SECONDS = 4.5;
export const WIDGET_COLUMNS = 26;
const FLAG_COLUMNS = 6;
const WIDGET_ROWS = 5;
const STAR_FADE_COLUMNS = 3;
const FLAG_START_COLUMN = 3;
const FLAG_COLUMN_SPACING = 10;
const RGB_CHANNEL_MASK = 255;
const RGB_CHANNEL_SHIFTS = [16, 8, 0] as const;
const HEX_RADIX = 16;
const STAR_BRIGHT_THRESHOLD = 0.8;
const STAR_MID_THRESHOLD = 0.4;
const ANSI_RESET = "\x1b[0m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";

const FIRST_MODE_ROOT = 1.875104068711961;
const SECOND_MODE_ROOT = 4.694091132974175;
const RIPPLE_WEIGHT = 0.6;

// Original clamped-free beam modes, precomputed outside animation ticks
// Tosi & Colonius, eqs 27–28: https://arxiv.org/abs/1903.03298
// Modal flag reconstruction: https://arxiv.org/abs/2602.06237 (section 3.2)
const WAVE_COLUMNS = (() => {
  const mode = (beta: number) => {
    const sigma =
      (Math.cosh(beta) + Math.cos(beta)) / (Math.sinh(beta) + Math.sin(beta));
    return (column: number) => {
      const x = (beta * column) / (FLAG_COLUMNS - 1);
      return Math.cosh(x) - Math.cos(x) - sigma * (Math.sinh(x) - Math.sin(x));
    };
  };
  const bendingMode = mode(FIRST_MODE_ROOT);
  const rippleMode = mode(SECOND_MODE_ROOT);
  const columns = Array.from({ length: FLAG_COLUMNS }, (_, column) => ({
    bend: bendingMode(column),
    ripple: RIPPLE_WEIGHT * rippleMode(column),
  }));
  const peak = Math.max(...columns.map(({ bend, ripple }) => Math.hypot(bend, ripple)));
  for (const column of columns) {
    column.bend /= peak;
    column.ripple /= peak;
  }
  return columns;
})();

function flagPixels(stripes: readonly string[]): Pixels {
  const colors = stripes.map((color) => ({
    foreground: fgAnsi(color, "truecolor"),
    background: bgAnsi(color, "truecolor"),
  }));
  const pixel = (offset: number, row: number) => {
    const top = colors[row * 2 - offset];
    const bottom = colors[row * 2 + 1 - offset];
    if (top && bottom) return `${top.foreground}${bottom.background}▀${ANSI_RESET}`;
    if (top) return `${top.foreground}▀${ANSI_RESET}`;
    if (bottom) return `${bottom.foreground}▄${ANSI_RESET}`;
    return " ";
  };
  const rows = (offset: number): Rows => [
    pixel(offset, 0),
    pixel(offset, 1),
    pixel(offset, 2),
    pixel(offset, 3),
  ];
  return [rows(0), rows(1), rows(2)];
}

function wave(pixels: Pixels, phase: number, strength: number): WaveRows {
  const rows: [string[], string[], string[], string[]] = [[], [], [], []];
  const bend = Math.sin(phase) * strength;
  const ripple = Math.cos(phase) * strength;
  for (const shape of WAVE_COLUMNS) {
    // Motion stays below 1.5 half-cells, so displacement is -1, 0, or 1
    const displacement = Math.round(bend * shape.bend + ripple * shape.ripple);
    const [top, upper, lower, bottom] =
      pixels[displacement < 0 ? 0 : displacement > 0 ? 2 : 1];
    rows[0].push(top);
    rows[1].push(upper);
    rows[2].push(lower);
    rows[3].push(bottom);
  }
  return rows;
}

const FLAGS = [
  {
    name: "Trans",
    stripes: ["#5bcefa", "#f5a9b8", "#ffffff", "#f5a9b8", "#5bcefa"],
  },
  {
    name: "bisexual",
    stripes: ["#d60270", "#d60270", "#9b4f96", "#0038a8", "#0038a8"],
  },
] as const;

export const FLAG_NAMES = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
}).format(FLAGS.map(({ name }) => name));

const PATCHES = FLAGS.map(({ stripes }, index) => ({
  column: FLAG_START_COLUMN + index * FLAG_COLUMN_SPACING,
  pixels: flagPixels(stripes),
}));

// Stars blend into the reported terminal background across the final columns
// Brighter stars grow from a dot into a sparkle, with staggered phases
const STARS = [
  [1, 0, "✧", "statusLinePath", 0.2],
  [5, 0, "⠂", "dim", 0],
  [9, 0, "·", "dim", 0],
  [11, 0, "✦", "accent", 3.8],
  [14, 0, "·", "dim", 0],
  [16, 0, "✦", "accent", 2.2],
  [20, 0, "·", "dim", 0],
  [23, 0, "⠂", "dim", 0],
  [0, 1, "⠂", "dim", 0],
  [10, 1, "✧", "statusLinePath", 1.6],
  [21, 1, "✧", "statusLinePath", 1],
  [1, 2, "✦", "syntaxKeyword", 4.6],
  [11, 2, "⠄", "dim", 0],
  [24, 2, "⠁", "dim", 0],
  [0, 3, "·", "dim", 0],
  [10, 3, "⠈", "dim", 0],
  [22, 3, "✦", "syntaxKeyword", 3.5],
  [1, 4, "✦", "accent", 2.5],
  [9, 4, "⠂", "dim", 0],
  [11, 4, "✦", "syntaxKeyword", 0.7],
  [13, 4, "✦", "syntaxKeyword", 2.7],
  [17, 4, "·", "dim", 0],
  [20, 4, "⠄", "dim", 0],
] as const satisfies readonly [
  column: number,
  row: number,
  glyph: string,
  color: ThemeColor,
  phase: number,
][];

const LAYOUT = Array.from({ length: WIDGET_ROWS }, (_, row) => ({
  row,
  stars: STARS.filter((star) => star[1] === row),
}));

type StarRow = {
  row: number;
  stars: {
    column: number;
    glyph: string;
    offset: number;
    dim: boolean;
    colors: readonly [string, string, string];
  }[];
};

function fadeAnsi(
  theme: Theme,
  color: ThemeColor,
  background: number,
  opacity: number,
): string {
  const hex = theme.getColorHex(color).slice(1);
  const foreground = Number.parseInt(
    hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex,
    HEX_RADIX,
  );
  const channels = RGB_CHANNEL_SHIFTS.map((shift) => {
    const base = (background >>> shift) & RGB_CHANNEL_MASK;
    return Math.round(
      base + (((foreground >>> shift) & RGB_CHANNEL_MASK) - base) * opacity,
    );
  });
  return `\x1b[38;2;${channels.join(";")}m`;
}

function prepareStarfield(theme: Theme, background: number): StarRow[] {
  return LAYOUT.map(({ row, stars }) => ({
    row,
    stars: stars.map(([column, , glyph, color, offset]) => {
      const fadeStart = WIDGET_COLUMNS - 1 - STAR_FADE_COLUMNS;
      const progress = Math.max(
        0,
        Math.min(1, (column - fadeStart) / STAR_FADE_COLUMNS),
      );
      const opacity = 1 - progress * progress * (3 - 2 * progress);
      return {
        column,
        glyph,
        offset,
        dim: color === "dim",
        colors: [
          fadeAnsi(theme, "dim", background, opacity),
          fadeAnsi(theme, "muted", background, opacity),
          fadeAnsi(theme, color, background, opacity),
        ],
      };
    }),
  }));
}

function starCells(stars: StarRow["stars"], phase: number): string[] {
  const cells = Array<string>(WIDGET_COLUMNS).fill(" ");
  for (const { column, glyph, offset, dim, colors } of stars) {
    const brightness = dim ? 0 : (1 + Math.sin(phase + offset)) / 2;
    const level =
      brightness > STAR_BRIGHT_THRESHOLD ? 2 : brightness > STAR_MID_THRESHOLD ? 1 : 0;
    const shape = dim || level === 2 ? glyph : level === 1 ? "⋆" : "·";
    cells[column] = `${colors[level]}${shape}${ANSI_FOREGROUND_RESET}`;
  }
  return cells;
}

function overlayFlagRow(
  cells: string[],
  flagRows: readonly WaveRows[],
  row: number,
): void {
  for (const [index, patch] of PATCHES.entries()) {
    const pixels = flagRows[index]?.[row];
    if (!pixels) continue;
    // Transparent cells reveal stardust below or beside a lifted flag
    for (const [column, pixel] of pixels.entries()) {
      if (pixel !== " ") cells[patch.column + column] = pixel;
    }
  }
}

const STAR_FIELDS = new WeakMap<Theme, { background: number; rows: StarRow[] }>();

export function renderBanner(
  theme: Theme,
  starPhase: number,
  flagPhase: number,
  strength: number,
): string {
  const background = getTerminalBackgroundColor();
  let field = STAR_FIELDS.get(theme);
  if (!field || field.background !== background) {
    field = { background, rows: prepareStarfield(theme, background) };
    STAR_FIELDS.set(theme, field);
  }
  const flagRows = PATCHES.map((patch, index) =>
    wave(patch.pixels, flagPhase + index * FLAG_PHASE_SPACING, strength),
  );
  return field.rows
    .map(({ row, stars }) => {
      const cells = starCells(stars, starPhase);
      if (row > 0) overlayFlagRow(cells, flagRows, row - 1);
      return cells.join("");
    })
    .join("\n");
}
