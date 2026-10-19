import type { Palette } from "../lib/theme.ts";

interface NativeObject {
  readonly nativeObject: unique symbol;
}
interface NativeDictionary extends NativeObject {
  readonly mutableCopy: NativeDictionary;
  objectForKey(key: string): NativeDictionary;
  setObjectForKey(value: NativeObject, key: string): void;
}
interface Frameworks {
  (value: unknown): NativeObject;
  NSColor: {
    colorWithSRGBRedGreenBlueAlpha(
      red: number,
      green: number,
      blue: number,
      alpha: number,
    ): NativeObject;
  };
  NSFont: {
    fontWithNameSize(name: string, size: number): NativeObject;
    monospacedSystemFontOfSizeWeight(size: number, weight: number): NativeObject;
  };
  NSKeyedArchiver: { archivedDataWithRootObject(value: NativeObject): NativeObject };
  NSMutableDictionary: {
    readonly dictionary: NativeDictionary;
    dictionaryWithDictionary(value: NativeObject): NativeDictionary;
  };
  NSUserDefaults: {
    readonly standardUserDefaults: {
      persistentDomainForName(name: string): NativeDictionary;
      stringForKey(key: string): NativeObject;
      setPersistentDomainForName(domain: NativeDictionary, name: string): void;
    };
  };
}
declare const $: Frameworks;
declare const ObjC: { import(name: string): void; unwrap(value: unknown): unknown };

// Keep this function self-contained so its JavaScript can run in JXA's
// Objective-C bridge after Bun erases the TypeScript declarations
export function nativeTerminal(
  palettes: { light: Palette; dark: Palette },
  write = true,
): string {
  ObjC.import("AppKit");
  const defaults = $.NSUserDefaults.standardUserDefaults;
  const existing = defaults.persistentDomainForName("com.apple.Terminal");
  const domain = ObjC.unwrap(existing)
    ? existing.mutableCopy
    : $.NSMutableDictionary.dictionary;
  const previousSettings = domain.objectForKey("Window Settings");
  const settings = ObjC.unwrap(previousSettings)
    ? previousSettings.mutableCopy
    : $.NSMutableDictionary.dictionary;
  let font = $.NSFont.fontWithNameSize("JetBrainsMonoNFM-Regular", 15);
  if (!ObjC.unwrap(font)) font = $.NSFont.monospacedSystemFontOfSizeWeight(15, 0);
  const archivedFont = $.NSKeyedArchiver.archivedDataWithRootObject(font);
  const colorRoles = {
    TextColor: "terminalForeground",
    TextBoldColor: "terminalCursor",
    BackgroundColor: "terminalBackground",
    CursorColor: "terminalCursor",
    SelectionColor: "surface1",
    ANSIBlackColor: "ansiBlack",
    ANSIRedColor: "red",
    ANSIGreenColor: "green",
    ANSIYellowColor: "yellow",
    ANSIBlueColor: "blue",
    ANSIMagentaColor: "pink",
    ANSICyanColor: "sky",
    ANSIWhiteColor: "ansiWhite",
    ANSIBrightBlackColor: "mutedForeground",
    ANSIBrightRedColor: "red",
    ANSIBrightGreenColor: "green",
    ANSIBrightYellowColor: "yellow",
    ANSIBrightBlueColor: "blue",
    ANSIBrightMagentaColor: "pink",
    ANSIBrightCyanColor: "sky",
    ANSIBrightWhiteColor: "ansiWhite",
  };
  function archiveColor(palette: Palette, role: string): NativeObject {
    const hex = palette[role];
    if (!hex) throw new Error(`Missing Terminal palette color: ${role}`);
    const number = Number.parseInt(hex.replace(/^#/, ""), 16);
    const color = $.NSColor.colorWithSRGBRedGreenBlueAlpha(
      (number >> 16) / 255,
      ((number >> 8) & 255) / 255,
      (number & 255) / 255,
      1,
    );
    return $.NSKeyedArchiver.archivedDataWithRootObject(color);
  }
  for (const variant of ["light", "dark"] as const) {
    const palette = palettes[variant];
    const name = `Catppuccin Custom ${variant === "light" ? "Light" : "Dark"}`;
    const values: Record<string, unknown> = {
      name,
      type: "Window Settings",
      ProfileCurrentVersion: 2.09,
      columnCount: 120,
      rowCount: 30,
      Font: archivedFont,
      FontAntialias: true,
      FontHeightSpacing: 1,
      FontWidthSpacing: 1,
      BackgroundBlur: 0,
      BackgroundBlurInactive: 0,
      BackgroundSettingsForInactiveWindows: false,
      DynamicANSIForegroundColors: false,
    };
    const colors = new Map<string, NativeObject>();
    for (const [key, role] of Object.entries(colorRoles)) {
      let archived = colors.get(role);
      if (!archived) {
        archived = archiveColor(palette, role);
        colors.set(role, archived);
      }
      values[key] = archived;
    }
    settings.setObjectForKey(
      $.NSMutableDictionary.dictionaryWithDictionary($(values)),
      name,
    );
  }
  const currentVariant =
    ObjC.unwrap(defaults.stringForKey("AppleInterfaceStyle")) === "Dark"
      ? "Dark"
      : "Light";
  domain.setObjectForKey(settings, "Window Settings");
  domain.setObjectForKey(
    $(`Catppuccin Custom ${currentVariant}`),
    "Default Window Settings",
  );
  domain.setObjectForKey(
    $(`Catppuccin Custom ${currentVariant}`),
    "Startup Window Settings",
  );
  domain.setObjectForKey($(2), "DefaultProfilesVersion");
  domain.setObjectForKey($(2.09), "ProfileCurrentVersion");
  if (write) defaults.setPersistentDomainForName(domain, "com.apple.Terminal");
  return "Native Terminal light and dark profiles contain archived colors and font";
}
