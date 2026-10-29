import type { Palette } from "@dotfiles/workstation/theme";
import type terminalPolicy from "./terminal.json";

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
  policy: typeof terminalPolicy,
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
  let font = $.NSFont.fontWithNameSize(policy.font.name, policy.font.size);
  if (!ObjC.unwrap(font))
    font = $.NSFont.monospacedSystemFontOfSizeWeight(policy.font.size, 0);
  const archivedFont = $.NSKeyedArchiver.archivedDataWithRootObject(font);
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
    const name = policy.profileNames[variant];
    const values: Record<string, unknown> = {
      ...policy.profile,
      name,
      type: "Window Settings",
      Font: archivedFont,
    };
    const colors = new Map<string, NativeObject>();
    for (const [key, role] of Object.entries(policy.colorRoles)) {
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
      ? "dark"
      : "light";
  domain.setObjectForKey(settings, "Window Settings");
  domain.setObjectForKey(
    $(policy.profileNames[currentVariant]),
    "Default Window Settings",
  );
  domain.setObjectForKey(
    $(policy.profileNames[currentVariant]),
    "Startup Window Settings",
  );
  domain.setObjectForKey($(policy.defaultProfilesVersion), "DefaultProfilesVersion");
  domain.setObjectForKey(
    $(policy.profile.ProfileCurrentVersion),
    "ProfileCurrentVersion",
  );
  if (write) defaults.setPersistentDomainForName(domain, "com.apple.Terminal");
  return "Native Terminal light and dark profiles contain archived colors and font";
}
