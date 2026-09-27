import { resolve } from "node:path";
import {
  type CatppuccinColors,
  type ColorName,
  flavors,
  version,
} from "@catppuccin/palette";
import { clampChroma, converter, formatHex, type Oklch, wcagContrast } from "culori";

// Run with: bun scripts/derive-custom-palette.ts
// Official palette data and types come from the version locked in bun.lock
// Hue describes identity; Catppuccin supplies lightness, chroma, and neutrals
// This is a design rule, not a claim of a uniquely correct aesthetic solution

// Unicode L2/19-080, page 1, lists pastel blue, pastel pink, and white
// Monica Helms, the flag's creator, is a coauthor; these are de facto digital
// reference colors, not a claim that Unicode specifies a normative flag standard
const FLAG_REFERENCE_URL = "https://unicode.org/L2/L2019/19080-transgender-flag.pdf";
const FLAG_COLORS = { pink: "#f5a9b8", blue: "#5bcefa", white: "#ffffff" } as const;

// Design parameter: nearby hues contribute more to lightness and chroma
// Half weight occurs at acos(1 - ln(2) / concentration), about 34 degrees
const HUE_CONCENTRATION = 4;
const DEGREES_TO_RADIANS = Math.PI / 180;
// WCAG normal-text minimum; checked against the rounded, gamut-mapped hex
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
const MINIMUM_TEXT_CONTRAST = 4.5;
const LIGHTNESS_RESOLUTION = 10_000;
const LIGHTNESS_MIN = 0;
const LIGHTNESS_MAX = 1;
const CONTRAST_SURFACES = [
  "base",
  "mantle",
  "crust",
  "surface0",
  "surface1",
  "surface2",
] as const;
const toOklch = converter("oklch");

function chromaticColor(value: string): Oklch & { h: number } {
  const color = toOklch(value);
  if (!color || color.h === undefined)
    throw new Error(`Expected a chromatic color: ${value}`);
  return { ...color, h: color.h };
}

function hex(color: Oklch): string {
  // Culori owns conversion, hue-preserving gamut mapping, and byte rounding
  return formatHex(clampChroma(color, "oklch", "rgb"));
}

function derive(colors: CatppuccinColors, reference: string): Oklch {
  const hue = chromaticColor(reference).h;
  let total = 0;
  let lightness = 0;
  let chroma = 0;
  // Circular kernel regression uses every accent without a 0/360-degree seam
  for (const color of Object.values(colors).filter((c) => c.accent)) {
    const { l, c, h } = color.oklch;
    const angle = (hue - h) * DEGREES_TO_RADIANS;
    const weight = Math.exp(HUE_CONCENTRATION * (Math.cos(angle) - 1));
    total += weight;
    lightness += weight * l;
    chroma += weight * c;
  }
  if (total === 0) throw new Error("Upstream palette has no accents");
  return { mode: "oklch", l: lightness / total, c: chroma / total, h: hue };
}

function foreground(color: Oklch, backgrounds: string[], dark: boolean): string {
  // Find the smallest lightness change on a 0.0001 grid that passes after
  // gamut mapping and 8-bit rounding; keep hue and requested chroma fixed
  for (let step = 0; step <= LIGHTNESS_RESOLUTION; step++) {
    const lightness = color.l + ((dark ? 1 : -1) * step) / LIGHTNESS_RESOLUTION;
    if (lightness < LIGHTNESS_MIN || lightness > LIGHTNESS_MAX) break;
    const result = hex({ ...color, l: lightness });
    if (backgrounds.every((bg) => wcagContrast(result, bg) >= MINIMUM_TEXT_CONTRAST))
      return result;
  }
  throw new Error("No readable foreground at this hue");
}

const path = resolve(
  import.meta.dir,
  "../dotfiles/.chezmoidata/catppuccin_custom.json",
);
const document = await Bun.file(path).json();
const theme = document.catppuccin_custom;
const fills = {
  pink: hex(derive(flavors.mocha.colors, FLAG_COLORS.pink)),
  blue: hex(derive(flavors.mocha.colors, FLAG_COLORS.blue)),
};
const fillForeground = flavors.mocha.colors.crust.hex;

for (const [mode, flavor] of Object.entries({
  light: flavors.latte,
  dark: flavors.mocha,
})) {
  const colors = flavor.colors;
  const p: Record<string, string> = theme[mode];
  const dark = mode === "dark";
  // Restore every upstream token before mapping the custom semantic roles
  for (const [name, color] of Object.entries(colors)) p[name] = color.hex;
  const groups: Partial<Record<ColorName, string[]>> = {
    base: ["canvas", "chrome", "toolbar", "codeBackground", "terminalBackground"],
    text: [
      "toolbarForeground",
      "toolbarControlForeground",
      "text",
      "secondaryForeground",
      "accentSurfaceForeground",
      "messageForeground",
      "codeForeground",
      "sidebarForeground",
      "terminalForeground",
    ],
    surface2: [
      "highlightHigh",
      "sidebarRowActive",
      "sidebarRowSelected",
      "terminalScrollbarHover",
    ],
  };
  for (const name of Object.keys(groups) as ColorName[]) {
    for (const role of groups[name] ?? []) p[role] = colors[name].hex;
  }
  p.surfaceRaised = colors[dark ? "surface0" : "base"].hex;
  p.surfaceOverlay = colors[dark ? "surface0" : "base"].hex;
  p.ansiWhite = colors[dark ? "text" : "surface2"].hex;
  p.accentWhite = colors[dark ? "text" : "base"].hex;
  const backgrounds = CONTRAST_SURFACES.map((name) => colors[name].hex);
  const pink = foreground(derive(colors, FLAG_COLORS.pink), backgrounds, dark);
  const blue = foreground(derive(colors, FLAG_COLORS.blue), backgrounds, dark);
  for (const role of ["pink", "rose", "update", "updateForeground"]) p[role] = pink;
  for (const role of ["blue", "sky", "foam", "focus", "info", "infoForeground"])
    p[role] = blue;
  for (const role of [
    "accent",
    "accentPink",
    "messageAction",
    "messageActionHover",
    "terminalCursor",
  ])
    p[role] = fills.pink;
  for (const role of ["accentBlue", "terminalSelection"]) p[role] = fills.blue;
  for (const role of [
    "accentForeground",
    "messageActionForeground",
    "selectionForeground",
  ])
    p[role] = fillForeground;
  for (const fill of Object.values(fills)) {
    if (wcagContrast(fill, fillForeground) < MINIMUM_TEXT_CONTRAST)
      throw new Error("Unreadable fill");
  }
  console.log(mode, { pink, blue, white: p.accentWhite, fills });
}

theme._source.customization =
  "Hue-guided OKLCH regression over all 14 upstream accents per flavor; native Catppuccin neutrals; Mocha-derived pastel fills in both modes; flavor-specific text adjusted only in lightness for contrast, with chroma reduction for sRGB gamut";
Object.assign(theme._source, {
  derivation: "scripts/derive-custom-palette.ts",
  pinnedUpstream: `@catppuccin/palette@${version}`,
  version,
  colorSpace: "OKLCH",
  weights: "exp(kappa * (cos(targetHue - accentHue) - 1))",
  kappa: String(HUE_CONCENTRATION),
  targetHueReferences: `pink ${FLAG_COLORS.pink}; blue ${FLAG_COLORS.blue}`,
  minimumTextContrast: String(MINIMUM_TEXT_CONTRAST),
  contrastSurfaces: CONTRAST_SURFACES.join(", "),
  accentReference: FLAG_REFERENCE_URL,
  referenceWhite: FLAG_COLORS.white,
  white: "light: Latte base; dark: Mocha text",
});
await Bun.write(path, `${JSON.stringify(document, null, 2)}\n`);
