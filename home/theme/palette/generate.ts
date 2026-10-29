import { resolve } from "node:path";
import {
  type CatppuccinColors,
  type CatppuccinFlavor,
  type CatppuccinFlavors,
  flavors,
  version,
} from "@catppuccin/palette";
import { DotfilesError } from "@dotfiles/core/errors";
import { writeJson } from "@dotfiles/core/files";
import { runMain } from "@dotfiles/core/runtime";
import { clampChroma, converter, formatHex, type Oklch, wcagContrast } from "culori";
import { Effect, Schema } from "effect";
import parameters from "./parameters.json";
import roles from "./roles.json";

// Run with: bun home/theme/palette/generate.ts
// Official palette data and types come from the version locked in bun.lock
// Hue describes identity; Catppuccin supplies lightness, chroma, and neutrals
// This is a design rule, not a claim of a uniquely correct aesthetic solution

export interface PaletteUpstream {
  flavors: CatppuccinFlavors;
  version: string;
}

const identifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/),
);
const flavorSchema = Schema.Literals(["latte", "frappe", "macchiato", "mocha"]);
const roleReferencesSchema = Schema.Record(
  identifierSchema,
  Schema.String.check(Schema.isPattern(/^(token|derived):[A-Za-z][A-Za-z0-9]*$/)),
);
const modeSchema = Schema.Struct({
  flavor: flavorSchema,
  roles: roleReferencesSchema,
});
const rolesSchema = Schema.Struct({
  common: roleReferencesSchema.check(Schema.isMinProperties(1)),
  modes: Schema.Struct({ light: modeSchema, dark: modeSchema }),
});
const parametersSchema = Schema.Struct({
  hueConcentration: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(Number.MIN_VALUE),
  ),
  minimumTextContrast: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 1, maximum: 21 }),
  ),
  contrastSurfaces: Schema.NonEmptyArray(identifierSchema),
  fillFlavor: flavorSchema,
  fillForeground: identifierSchema,
  reference: Schema.Struct({
    url: Schema.String.check(
      Schema.makeFilter((value) => URL.canParse(value), { expected: "a URL" }),
    ),
    pink: Schema.String,
    blue: Schema.String,
    white: Schema.String,
  }),
});
const parseRoles = Schema.decodeUnknownSync(rolesSchema, {
  onExcessProperty: "error",
});
const parseParameters = Schema.decodeUnknownSync(parametersSchema, {
  onExcessProperty: "error",
});

export type PaletteParameters = typeof parametersSchema.Type;
type RoleDefinitions = typeof rolesSchema.Type;
type RoleReferences = typeof roleReferencesSchema.Type;
type Mode = keyof RoleDefinitions["modes"];

export interface PaletteDocument {
  catppuccin_custom: {
    _source: Record<string, string>;
    light: Record<string, string>;
    dark: Record<string, string>;
  };
}

const MODES = ["light", "dark"] as const;
const DEGREES_TO_RADIANS = Math.PI / 180;
const LIGHTNESS_RESOLUTION = 10_000;
const toOklch = converter("oklch");

function roleDefinitions(value: unknown): RoleDefinitions {
  const parsed = parseRoles(value);
  const common = parsed.common;
  for (const mode of MODES) {
    for (const role of Object.keys(parsed.modes[mode].roles)) {
      if (Object.hasOwn(common, role))
        throw new Error(`Role ${role} must be common or mode-specific, not both`);
    }
  }
  const lightKeys = Object.keys({ ...common, ...parsed.modes.light.roles });
  const darkRoles = { ...common, ...parsed.modes.dark.roles };
  if (
    lightKeys.length !== Object.keys(darkRoles).length ||
    lightKeys.some((key) => !Object.hasOwn(darkRoles, key))
  )
    throw new Error("Light and dark modes must define the same public roles");
  return parsed;
}

function flavor(upstream: PaletteUpstream, name: string): CatppuccinFlavor {
  if (!Object.hasOwn(upstream.flavors, name))
    throw new Error(`Unresolved upstream flavor: ${name}`);
  return upstream.flavors[name as keyof CatppuccinFlavors];
}

function token(colors: CatppuccinColors, name: string): string {
  if (!Object.hasOwn(colors, name))
    throw new Error(`Unresolved upstream token: ${name}`);
  return colors[name as keyof CatppuccinColors].hex;
}

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

function derive(
  colors: CatppuccinColors,
  reference: string,
  concentration: number,
): Oklch {
  const hue = chromaticColor(reference).h;
  let total = 0;
  let lightness = 0;
  let chroma = 0;
  // Circular kernel regression uses every accent without a 0/360-degree seam
  // Half weight occurs at acos(1 - ln(2) / concentration), about 34 degrees at 4
  for (const color of Object.values(colors).filter((c) => c.accent)) {
    const { l, c, h } = color.oklch;
    const angle = (hue - h) * DEGREES_TO_RADIANS;
    const weight = Math.exp(concentration * (Math.cos(angle) - 1));
    total += weight;
    lightness += weight * l;
    chroma += weight * c;
  }
  if (total === 0) throw new Error("Upstream palette has no accents");
  return { mode: "oklch", l: lightness / total, c: chroma / total, h: hue };
}

function foreground(
  color: Oklch,
  backgrounds: string[],
  dark: boolean,
  minimumContrast: number,
): string {
  // Find the smallest lightness change on a 0.0001 grid that passes after
  // gamut mapping and 8-bit rounding; keep hue and requested chroma fixed
  // WCAG: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
  for (let step = 0; step <= LIGHTNESS_RESOLUTION; step++) {
    const lightness = color.l + ((dark ? 1 : -1) * step) / LIGHTNESS_RESOLUTION;
    if (lightness < 0 || lightness > 1) break;
    const result = hex({ ...color, l: lightness });
    if (backgrounds.every((bg) => wcagContrast(result, bg) >= minimumContrast))
      return result;
  }
  throw new Error("No readable foreground at this hue");
}

function resolveRoles(
  references: RoleReferences,
  colors: CatppuccinColors,
  derived: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(references).map(([role, reference]) => {
      const [kind, name] = reference.split(":") as [string, string];
      if (kind === "token") return [role, token(colors, name)];
      const value = Object.hasOwn(derived, name) ? derived[name] : undefined;
      if (value === undefined) throw new Error(`Unresolved derived color: ${name}`);
      return [role, value];
    }),
  );
}

// No previous output, filesystem state, or mutation of the supplied inputs
export function buildPalette(
  upstream: PaletteUpstream,
  roleInput: unknown,
  parameterInput: unknown,
): PaletteDocument {
  const definitions = roleDefinitions(roleInput);
  const parameters = parseParameters(parameterInput);
  const fillFlavor = flavor(upstream, parameters.fillFlavor);
  const fillForeground = token(fillFlavor.colors, parameters.fillForeground);
  const pinkFill = hex(
    derive(fillFlavor.colors, parameters.reference.pink, parameters.hueConcentration),
  );
  const blueFill = hex(
    derive(fillFlavor.colors, parameters.reference.blue, parameters.hueConcentration),
  );
  for (const fill of [pinkFill, blueFill]) {
    if (wcagContrast(fill, fillForeground) < parameters.minimumTextContrast)
      throw new Error("Unreadable fill");
  }
  const modes = Object.fromEntries(
    MODES.map((mode) => {
      const definition = definitions.modes[mode];
      const selected = flavor(upstream, definition.flavor);
      const backgrounds = parameters.contrastSurfaces.map((name) =>
        token(selected.colors, name),
      );
      const derived = {
        pinkFill,
        blueFill,
        fillForeground,
        pinkForeground: foreground(
          derive(
            selected.colors,
            parameters.reference.pink,
            parameters.hueConcentration,
          ),
          backgrounds,
          selected.dark,
          parameters.minimumTextContrast,
        ),
        blueForeground: foreground(
          derive(
            selected.colors,
            parameters.reference.blue,
            parameters.hueConcentration,
          ),
          backgrounds,
          selected.dark,
          parameters.minimumTextContrast,
        ),
      };
      return [
        mode,
        resolveRoles(
          { ...definitions.common, ...definition.roles },
          selected.colors,
          derived,
        ),
      ];
    }),
  ) as Record<Mode, Record<string, string>>;
  return {
    catppuccin_custom: {
      _source: {
        name: "Catppuccin Custom",
        repository: "https://github.com/catppuccin/palette",
        version: upstream.version,
        light: flavor(upstream, definitions.modes.light.flavor).name,
        dark: flavor(upstream, definitions.modes.dark.flavor).name,
        customization: `Hue-guided OKLCH regression over all upstream accents per flavor; native Catppuccin neutrals; ${fillFlavor.name}-derived pastel fills in both modes; flavor-specific text adjusted only in lightness for contrast, with chroma reduction for sRGB gamut`,
        derivation: "home/theme/palette/generate.ts",
        roles: "home/theme/palette/roles.json",
        parameters: "home/theme/palette/parameters.json",
        pinnedUpstream: `@catppuccin/palette@${upstream.version}`,
        colorSpace: "OKLCH",
        weights: "exp(kappa * (cos(targetHue - accentHue) - 1))",
        kappa: String(parameters.hueConcentration),
        targetHueReferences: `pink ${parameters.reference.pink}; blue ${parameters.reference.blue}`,
        minimumTextContrast: String(parameters.minimumTextContrast),
        contrastSurfaces: parameters.contrastSurfaces.join(", "),
        // Unicode L2/19-080 lists pastel blue, pastel pink, and white on page 1
        // Monica Helms is a coauthor; these are de facto digital references
        // Unicode does not specify a normative flag color standard
        accentReference: parameters.reference.url,
        referenceWhite: parameters.reference.white,
        white: MODES.map((mode) => {
          const definition = definitions.modes[mode];
          return `${mode}: ${flavor(upstream, definition.flavor).name} ${
            definition.roles.accentWhite ?? definitions.common.accentWhite
          }`;
        }).join("; "),
      },
      light: modes.light,
      dark: modes.dark,
    },
  };
}

if (import.meta.main) {
  runMain(
    Effect.gen(function* () {
      const document = yield* Effect.try({
        try: () => buildPalette({ flavors, version }, roles, parameters),
        catch: (cause) => new DotfilesError("Could not build palette", { cause }),
      });
      yield* writeJson(resolve(import.meta.dir, "palette.json"), document);
    }),
  );
}
