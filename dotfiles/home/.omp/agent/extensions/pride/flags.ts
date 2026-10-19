import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { bgAnsi, fgAnsi } from "@oh-my-pi/pi-tui/theme/color";

export type Rows<T = string> = readonly [T, T, T, T];
type Pixels = readonly [Rows, Rows, Rows];
export const ROW_INDICES = [0, 1, 2, 3] as const;

export const FULL_TURN = 2 * Math.PI;
const FLAG_COLUMNS = 8;
const HALF_CELLS_PER_ROW = 2;
const CENTER_OFFSET = 1;

// First two positive roots of cosh(beta) * cos(beta) = -1 for a clamped-free beam
const FIRST_MODE_ROOT = 1.875104068711961;
const SECOND_MODE_ROOT = 4.694091132974175;

// Visual tuning: relative ripple amplitude and inter-flag phase spacing in radians
const RIPPLE_WEIGHT = 0.6;
export const FLAG_PHASE_SPACING = 1.2;

// Strength is measured in half-cells; period is measured in seconds
export const MOTION = {
  idle: { strength: 0.65, periodSeconds: 7 },
  waiting: { strength: 0.95, periodSeconds: 3.5 },
  streaming: { strength: 1.35, periodSeconds: 1.4 },
  working: { strength: 1.45, periodSeconds: 1 },
} as const;
export type Activity = keyof typeof MOTION;

// Precompute cantilever mode shapes once, not on animation ticks
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
    const top = colors[row * HALF_CELLS_PER_ROW - offset];
    const bottom = colors[row * HALF_CELLS_PER_ROW + 1 - offset];
    if (top && bottom) return `${top.foreground}${bottom.background}▀\x1b[0m`;
    if (top) return `${top.foreground}▀\x1b[0m`;
    if (bottom) return `${bottom.foreground}▄\x1b[0m`;
    return " ";
  };
  const rows = (offset: number): Rows => [
    pixel(offset, 0),
    pixel(offset, 1),
    pixel(offset, 2),
    pixel(offset, 3),
  ];
  return [rows(0), rows(CENTER_OFFSET), rows(2 * CENTER_OFFSET)];
}

type Decoration = readonly [color: ThemeColor, glyph: string];

// Decorations specify the top and bottom row; middle rows keep the same spacing
const FLAGS = [
  {
    stripes: ["#5bcefa", "#f5a9b8", "#ffffff", "#f5a9b8", "#5bcefa"],
    decorations: [["statusLinePath", "✧"], undefined, undefined, ["accent", "·"]],
  },
  {
    stripes: ["#d60270", "#d60270", "#9b4f96", "#0038a8", "#0038a8"],
    decorations: [["accent", "✦"], undefined, undefined, ["syntaxKeyword", "⋆"]],
  },
  {
    stripes: ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"],
    decorations: [["warning", "⋆"], undefined, undefined, ["statusLinePath", "✧"]],
  },
] as const satisfies readonly {
  stripes: readonly `#${string}`[];
  decorations: Rows<Decoration | undefined>;
}[];
export const RENDERED_FLAGS = FLAGS.map(({ stripes, decorations }) => ({
  pixels: flagPixels(stripes),
  decorations,
}));
// Four-column prefixes, one-column gaps, and the final three-column decoration
export const WIDGET_COLUMNS = FLAGS.length * (FLAG_COLUMNS + 4) + FLAGS.length - 1 + 3;

// The clamped edge stays still; phase-shifted bending modes ripple toward the tip The
// sampled envelope is at most one, keeping all stripes in four fixed rows
export function wave(pixels: Pixels, phase: number, strength: number): Rows {
  const rows: [...Rows] = ["", "", "", ""];
  const bend = Math.sin(phase) * strength;
  const ripple = Math.cos(phase) * strength;
  for (const shape of WAVE_COLUMNS) {
    // Motion stays below 1.5 half-cells, so displacement is -1, 0, or 1
    const displacement = Math.round(bend * shape.bend + ripple * shape.ripple);
    const [top, upper, lower, bottom] =
      pixels[displacement < 0 ? 0 : displacement > 0 ? 2 : 1];
    rows[0] += top;
    rows[1] += upper;
    rows[2] += lower;
    rows[3] += bottom;
  }
  return rows;
}
