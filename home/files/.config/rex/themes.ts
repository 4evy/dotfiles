interface NativeValue {
  readonly nativeValue: unique symbol;
}

interface NativeString extends NativeValue {
  dataUsingEncoding(encoding: number): NativeValue;
}

interface Frameworks {
  (value: string): NativeString;
  NSHomeDirectory(): NativeString;
  readonly NSUTF8StringEncoding: number;
  NSString: {
    alloc: {
      initWithDataEncoding(data: NativeValue, encoding: number): NativeString;
    };
    stringWithContentsOfFileEncodingError(
      path: string,
      encoding: number,
      error: null,
    ): NativeString;
  };
  NSUserDefaults: {
    alloc: {
      initWithSuiteName(name: string): {
        dataForKey(key: string): NativeValue;
        stringForKey(key: string): NativeString;
        setObjectForKey(value: NativeValue, key: string): void;
        readonly synchronize: boolean;
      };
    };
  };
}

declare const $: Frameworks;
declare const ObjC: {
  import(name: string): void;
  unwrap(value: NativeString): string;
  unwrap(value: NativeValue): unknown;
};

interface RexTheme {
  id: string;
  [key: string]: unknown;
}

interface RexColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  colorSpace: string;
}

// Keep runtime dependencies inside this function for JXA's separate process
// Bun erases the types before toString passes its JavaScript to osascript
function syncThemes() {
  ObjC.import("Foundation");
  const home = ObjC.unwrap($.NSHomeDirectory());
  const defaults = $.NSUserDefaults.alloc.initWithSuiteName("com.superlogical.rex");
  const key = "Workspace.customThemes";
  const data = defaults.dataForKey(key);
  const current: RexTheme[] = ObjC.unwrap(data)
    ? JSON.parse(
        ObjC.unwrap(
          $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding),
        ),
      )
    : [];
  const ids = {
    light: "custom-CFED6B8C-F639-4BDC-A01E-D62C29E5FE37",
    dark: "custom-C557D18D-F043-4947-B9A9-A60885C51B80",
  };

  function color(hex: string | undefined) {
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) {
      throw new Error(`Invalid Rex theme color: ${hex}`);
    }
    const value = parseInt(hex.slice(1), 16);
    return {
      red: (value >> 16) / 255,
      green: ((value >> 8) & 255) / 255,
      blue: (value & 255) / 255,
      alpha: 1,
      colorSpace: "srgb",
    };
  }

  const managed = (["light", "dark"] as const).map((appearance) => {
    const path = `${home}/.config/ghostty/themes/catppuccin-custom-${appearance}.conf`;
    const contents = $.NSString.stringWithContentsOfFileEncodingError(
      path,
      $.NSUTF8StringEncoding,
      null,
    );
    if (!ObjC.unwrap(contents)) throw new Error(`Cannot read ${path}`);
    const values: Record<string, string> = {};
    const ansi: RexColor[] = [];
    for (const line of ObjC.unwrap(contents).split("\n")) {
      const match = line.match(/^([a-z-]+)\s*=\s*(.+)$/);
      const name = match?.[1];
      const value = match?.[2];
      if (!name || !value) continue;
      if (name === "palette") {
        const entry = value.match(/^(\d+)=(#[0-9a-f]{6})$/i);
        if (!entry?.[1] || !entry[2]) {
          throw new Error(`Invalid Rex ANSI color: ${line}`);
        }
        ansi[Number(entry[1])] = color(entry[2]);
      } else {
        values[name] = value;
      }
    }
    for (let index = 0; index < 16; index++) {
      if (!ansi[index]) throw new Error(`Missing Rex ANSI color ${index}`);
    }
    return {
      id: ids[appearance],
      name: `Catppuccin Custom ${appearance === "light" ? "Light" : "Dark"}`,
      appearance,
      // Stable metadata keeps repeated applies byte-identical
      createdAt: 0,
      source: { manual: {} },
      palette: {
        background: color(values.background),
        foreground: color(values.foreground),
        cursor: color(values["cursor-color"]),
        cursorText: color(values["cursor-text"]),
        selectionBackground: color(values["selection-background"]),
        selectionForeground: color(values["selection-foreground"]),
        ansi,
        paletteBase: {},
        paletteOverrides: {},
        paletteGenerate: values["palette-generate"] === "true",
        paletteHarmonious: true,
      },
    };
  });
  const updated = current.filter(
    (theme) => !managed.some((item) => item.id === theme.id),
  );
  updated.push(...managed);
  const json = JSON.stringify(updated);
  if (JSON.stringify(current) !== json) {
    defaults.setObjectForKey($(json).dataUsingEncoding($.NSUTF8StringEncoding), key);
  }
  for (const appearance of ["light", "dark"] as const) {
    const selection = `Workspace.${appearance}ThemeID`;
    if (ObjC.unwrap(defaults.stringForKey(selection)) !== ids[appearance]) {
      defaults.setObjectForKey($(ids[appearance]), selection);
    }
  }
  if (!defaults.synchronize) throw new Error("Could not save Rex themes");
  return "Rex Catppuccin light and dark themes synchronized";
}

process.exitCode = await Bun.spawn(
  ["/usr/bin/osascript", "-l", "JavaScript", "-e", `(${syncThemes.toString()})()`],
  { stdout: "inherit", stderr: "inherit" },
).exited;
