import { DotfilesError, UsageError } from "@dotfiles/core/errors";
import { writeIfChanged } from "@dotfiles/core/files";
import settings from "@dotfiles/workstation/assets/kmscon" with { type: "text" };
import { solarDay } from "@dotfiles/workstation/solar";
import type { Palette } from "@dotfiles/workstation/theme";
import {
  color,
  paletteDocumentSchema,
  rgbComponents,
} from "@dotfiles/workstation/theme";
import { Clock, Config, Effect, FileSystem, Schema } from "effect";

import defaults from "./defaults.json";

const coordinate = Effect.fn("kmscon.coordinate")(function* (
  name: string,
  minimum: number,
  maximum: number,
) {
  const value = yield* Config.String(name).pipe(Config.withDefault(""));
  if (!value) return undefined;
  const validCoordinate = Schema.String.check(
    Schema.makeFilter<string>((input) => {
      const number = Number(input);
      return (
        Boolean(input.trim()) &&
        Number.isFinite(number) &&
        number >= minimum &&
        number <= maximum
      );
    }),
  );
  yield* Schema.decodeUnknownEffect(validCoordinate)(value).pipe(
    Effect.mapError(
      () =>
        new DotfilesError(
          `${name} must be between ${minimum} and ${maximum}: ${value}`,
        ),
    ),
  );
  return Number(value);
});

const theme = Effect.fn("kmscon.theme")(function* (now: Date) {
  const forced = yield* Config.String("DOTFILES_KMSCON_THEME").pipe(
    Config.withDefault(""),
  );
  if (forced) {
    const name = yield* Schema.decodeUnknownEffect(Schema.Literals(["light", "dark"]))(
      forced,
    ).pipe(
      Effect.mapError(
        () => new DotfilesError(`Unsupported DOTFILES_KMSCON_THEME: ${forced}`),
      ),
    );
    return { name, source: "DOTFILES_KMSCON_THEME" };
  }
  let latitude = yield* coordinate("DOTFILES_KMSCON_LATITUDE", -90, 90);
  let longitude = yield* coordinate("DOTFILES_KMSCON_LONGITUDE", -180, 180);
  const location =
    latitude === undefined && longitude === undefined ? defaults.location.name : "env";
  if (location === defaults.location.name) {
    latitude = defaults.location.latitude;
    longitude = defaults.location.longitude;
  }
  if (latitude === undefined || longitude === undefined)
    return yield* Effect.fail(
      new DotfilesError(
        "Set both DOTFILES_KMSCON_LATITUDE and DOTFILES_KMSCON_LONGITUDE for sun-based theme selection",
      ),
    );
  const { sunrise, sunset, elevation } = solarDay(now, latitude, longitude);
  if (!sunrise || !sunset)
    return {
      name: elevation >= 0 ? ("light" as const) : ("dark" as const),
      source: `sun polar latitude=${coordinateText(latitude)} longitude=${coordinateText(longitude)} elevation=${elevation.toFixed(2)}`,
    };
  return {
    name: sunrise <= now && now < sunset ? ("light" as const) : ("dark" as const),
    source: `sun ${location} latitude=${coordinateText(latitude)} longitude=${coordinateText(longitude)}`,
  };
});

function coordinateText(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function renderKmscon(
  palettes: { light: Palette; dark: Palette },
  choice: { name: "light" | "dark"; source: string },
): string {
  const mapping =
    choice.name === "light"
      ? { ...defaults.roles, ...defaults.lightRoles }
      : defaults.roles;
  const lines = [
    "# Managed by dotfiles",
    `# Theme: catppuccin-custom-${choice.name}`,
    `# Theme source: ${choice.source}`,
    settings.trimEnd(),
  ];
  for (const [option, role] of Object.entries(mapping))
    lines.push(
      `palette-${option}=${rgbComponents(color(palettes[choice.name], role))
        .map((component) => Math.round(component * 255))
        .join(",")}`,
    );
  return `${lines.join("\n")}\n`;
}

export const kmsconTheme = Effect.fn("kmsconTheme")(function* (args: string[]) {
  const [input, output] = args;
  if (args.length !== 2 || !input || !output)
    return yield* Effect.fail(
      new UsageError("Usage: kmscon-theme-config PALETTE_JSON OUTPUT_CONFIG"),
    );
  const fs = yield* FileSystem.FileSystem;
  const document = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(paletteDocumentSchema),
  )(yield* fs.readFileString(input));
  const choice = yield* theme(new Date(yield* Clock.currentTimeMillis));
  const contents = yield* Effect.try({
    try: () => renderKmscon(document.catppuccin_custom, choice),
    catch: (cause) =>
      cause instanceof DotfilesError ? cause : new DotfilesError(String(cause)),
  });
  yield* writeIfChanged(output, contents);
  return 0;
});
