import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { output, run } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { ensureDirectory, writeJson } from "@dotfiles/core/files";
import type { Palette } from "@dotfiles/workstation/theme";
import { color, palettes } from "@dotfiles/workstation/theme";
import type { PlatformError } from "effect";
import { Effect, FileSystem, Schema } from "effect";
import Builder from "fast-xml-builder";
import { zipSync } from "fflate";

const upstreamId = "catppuccin.catppuccin-vsc-icons";
const extensionMetadata = {
  name: "catppuccin-custom-catppuccin-icons",
  displayName: "Catppuccin Custom — Catppuccin Icons",
  description: "Catppuccin file icon shapes using the Catppuccin Custom palette.",
  publisher: "evy",
  engines: { vscode: "^1.83.0" },
  categories: ["Themes"],
};
const extensionId = `${extensionMetadata.publisher}.${extensionMetadata.name}`;
const lightPrefix = "__catppuccin_custom_light__";
const associationSchema = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.String),
]);
const themeSchema = Schema.StructWithRest(
  Schema.Struct({
    iconDefinitions: Schema.Record(
      Schema.String,
      Schema.StructWithRest(Schema.Struct({ iconPath: Schema.String }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const prefixReferences = Effect.fn("prefixReferences")(function* (value: unknown) {
  const association = yield* Schema.decodeUnknownEffect(associationSchema)(value);
  if (typeof association === "string") return `${lightPrefix}${association}`;
  return Object.fromEntries(
    Object.entries(association).map(([key, item]) => [key, `${lightPrefix}${item}`]),
  );
});

const buildTheme = Effect.fn("buildTheme")(function* (upstream: string) {
  const fs = yield* FileSystem.FileSystem;
  const input = yield* fs.readFileString(join(upstream, "dist/mocha/theme.json"));
  const { iconDefinitions, ...theme } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(themeSchema),
  )(input);
  const associations = yield* Effect.forEach(
    Object.entries(theme).filter(([key]) => key !== "hidesExplorerArrows"),
    ([key, value]) =>
      Effect.map(prefixReferences(value), (reference) => [key, reference]),
  );
  const light = Object.fromEntries(associations);
  const definitions: Record<string, unknown> = {};
  for (const [variant, prefix] of [
    ["dark", ""],
    ["light", lightPrefix],
  ]) {
    for (const [name, definition] of Object.entries(iconDefinitions))
      definitions[`${prefix}${name}`] = {
        ...definition,
        iconPath: definition.iconPath.replace("./icons/", `./icons/${variant}/`),
      };
  }
  return { ...theme, light, iconDefinitions: definitions };
});

function copyIcons(
  source: string,
  destination: string,
  palette: Palette,
): Effect.Effect<
  void,
  PlatformError.PlatformError | DotfilesError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* ensureDirectory(destination);
    for (const entry of yield* fs.readDirectory(source)) {
      const input = join(source, entry);
      const output = join(destination, entry);
      if ((yield* fs.lstat(input)).type === "Directory")
        yield* copyIcons(input, output, palette);
      else {
        const content = yield* fs.readFileString(input);
        const svg = yield* Effect.try({
          try: () =>
            content.replace(
              /var\(--vscode-ctp-([a-z0-9-]+)\)/g,
              (_match, role: string) => color(palette, role),
            ),
          catch: (error) =>
            error instanceof DotfilesError ? error : new DotfilesError(String(error)),
        });
        yield* fs.writeFileString(output, svg);
      }
    }
  });
}

function files(
  directory: string,
): Effect.Effect<string[], PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result: string[] = [];
    // Sort by path components to match pathlib's content-version traversal
    for (const entry of (yield* fs.readDirectory(directory)).sort()) {
      const path = join(directory, entry);
      const status = yield* fs.lstat(path);
      if (status.type === "Directory") result.push(...(yield* files(path)));
      else if (status.type === "File") result.push(path);
    }
    return result;
  });
}

const contentVersion = Effect.fn("contentVersion")(function* (extension: string) {
  const fs = yield* FileSystem.FileSystem;
  const digest = createHash("sha256");
  for (const path of yield* files(extension))
    digest.update(relative(extension, path)).update(yield* fs.readFile(path));
  return `1.0.${digest.digest().readUInt32BE(0)}`;
});

const buildVSIX = Effect.fn("buildVSIX")(function* (
  extension: string,
  destination: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const builder = new Builder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
    suppressBooleanAttributes: false,
  });
  const declaration = { "@_version": "1.0", "@_encoding": "utf-8" };
  const contentTypes = builder.build({
    "?xml": declaration,
    Types: {
      "@_xmlns": "http://schemas.openxmlformats.org/package/2006/content-types",
      Default: [
        { "@_Extension": "json", "@_ContentType": "application/json" },
        { "@_Extension": "svg", "@_ContentType": "image/svg+xml" },
        { "@_Extension": "vsixmanifest", "@_ContentType": "text/xml" },
      ],
    },
  });
  const manifest = builder.build({
    "?xml": declaration,
    PackageManifest: {
      "@_Version": "2.0.0",
      "@_xmlns": "http://schemas.microsoft.com/developer/vsx-schema/2011",
      Metadata: {
        Identity: {
          "@_Id": extensionMetadata.name,
          "@_Version": version,
          "@_Publisher": extensionMetadata.publisher,
          "@_Language": "en-US",
        },
        DisplayName: extensionMetadata.displayName,
        Description: {
          "@_xml:space": "preserve",
          "#text": extensionMetadata.description,
        },
        Categories: extensionMetadata.categories.join(","),
        Properties: {
          Property: [
            {
              "@_Id": "Microsoft.VisualStudio.Code.Engine",
              "@_Value": extensionMetadata.engines.vscode,
            },
            {
              "@_Id": "Microsoft.VisualStudio.Services.Content.Pricing",
              "@_Value": "Free",
            },
          ],
        },
      },
      Installation: { InstallationTarget: { "@_Id": "Microsoft.VisualStudio.Code" } },
      Dependencies: "",
      Assets: {
        Asset: {
          "@_Type": "Microsoft.VisualStudio.Code.Manifest",
          "@_Path": "extension/package.json",
          "@_Addressable": "true",
        },
      },
    },
  });
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": Buffer.from(contentTypes),
    "extension.vsixmanifest": Buffer.from(manifest),
  };
  for (const path of yield* files(extension))
    entries[`extension/${relative(extension, path)}`] = yield* fs.readFile(path);
  yield* fs.writeFile(destination, zipSync(entries));
});

export const vscodeIcons = Effect.fn("vscodeIcons")(function* () {
  const code = yield* Effect.sync(() => Bun.which("code"));
  if (!code) return;
  const fs = yield* FileSystem.FileSystem;
  const upstream = (yield* output([code, "--locate-extension", upstreamId])).trim();
  if (!upstream) return;
  if (!(yield* fs.exists(upstream)))
    return yield* Effect.fail(
      new DotfilesError("Code reported a missing Catppuccin extension"),
    );
  // Invalidate the upstream activation sentinel when Hjem changes the palette
  yield* fs.remove(join(upstream, "themes/.flag"), { force: true });
  const temporary = yield* fs.makeTempDirectoryScoped({
    directory: dirname(upstream),
    prefix: `.${extensionId}-`,
  });
  const extension = yield* ensureDirectory(join(temporary, "extension"));
  yield* writeJson(join(extension, "theme.json"), yield* buildTheme(upstream));
  for (const variant of ["dark", "light"] as const)
    yield* copyIcons(
      join(upstream, "dist/unflavored"),
      join(extension, "icons", variant),
      palettes[variant],
    );
  const version = yield* contentVersion(extension);
  yield* writeJson(join(extension, "package.json"), {
    name: extensionMetadata.name,
    displayName: extensionMetadata.displayName,
    description: extensionMetadata.description,
    version,
    publisher: extensionMetadata.publisher,
    engines: extensionMetadata.engines,
    categories: extensionMetadata.categories,
    contributes: {
      iconThemes: [
        {
          id: extensionMetadata.name,
          label: extensionMetadata.displayName,
          path: "./theme.json",
        },
      ],
    },
  });
  const vsix = join(temporary, `${extensionId}-${version}.vsix`);
  yield* buildVSIX(extension, vsix, version);
  yield* run([code, "--install-extension", vsix, "--force"]);
}, Effect.scoped);
