import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { zipSync } from "fflate";
import * as v from "valibot";
import { output, run, which } from "../../../../../lib/typescript/commands.ts";
import { DotfilesError } from "../../../../../lib/typescript/errors.ts";
import { ensureDirectory } from "../../../../../lib/typescript/files.ts";
import type { Palette } from "../../lib/theme.ts";
import { color, palettes } from "../../lib/theme.ts";

const upstreamId = "catppuccin.catppuccin-vsc-icons";
const customName = "catppuccin-custom-catppuccin-icons";
const publisher = "evy";
const extensionId = `${publisher}.${customName}`;
const lightPrefix = "__catppuccin_custom_light__";
const objectInput = v.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const associationSchema = v.union([
  v.string(),
  v.pipe(objectInput, v.record(v.string(), v.string())),
]);
const themeSchema = v.pipe(
  objectInput,
  v.looseObject({
    iconDefinitions: v.pipe(
      objectInput,
      v.record(
        v.string(),
        v.pipe(objectInput, v.looseObject({ iconPath: v.string() })),
      ),
    ),
  }),
);

function prefixReferences(value: unknown): string | Record<string, string> {
  const association = v.parse(associationSchema, value);
  if (typeof association === "string") return `${lightPrefix}${association}`;
  return Object.fromEntries(
    Object.entries(association).map(([key, item]) => [key, `${lightPrefix}${item}`]),
  );
}

function buildTheme(upstream: string): Record<string, unknown> {
  const { iconDefinitions, ...theme } = v.parse(
    themeSchema,
    JSON.parse(readFileSync(join(upstream, "dist/mocha/theme.json"), "utf8")),
  );
  const light = Object.fromEntries(
    Object.entries(theme)
      .filter(([key]) => key !== "hidesExplorerArrows")
      .map(([key, value]) => [key, prefixReferences(value)]),
  );
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
}

function copyIcons(source: string, destination: string, palette: Palette): void {
  ensureDirectory(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = join(source, entry.name);
    const output = join(destination, entry.name);
    if (entry.isDirectory()) copyIcons(input, output, palette);
    else {
      const svg = readFileSync(input, "utf8").replace(
        /var\(--vscode-ctp-([a-z0-9-]+)\)/g,
        (_match, role: string) => color(palette, role),
      );
      writeFileSync(output, svg);
    }
  }
}

function writeJSON(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function files(directory: string): string[] {
  const result: string[] = [];
  // Sort by path components to match pathlib's content-version traversal
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function contentVersion(extension: string): string {
  const digest = createHash("sha256");
  for (const path of files(extension))
    digest.update(relative(extension, path)).update(readFileSync(path));
  return `1.0.${digest.digest().readUInt32BE(0)}`;
}

function buildVSIX(extension: string, destination: string, version: string): void {
  const contentTypes =
    '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="json" ContentType="application/json" />\n  <Default Extension="svg" ContentType="image/svg+xml" />\n  <Default Extension="vsixmanifest" ContentType="text/xml" />\n</Types>\n';
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="${customName}" Version="${version}" Publisher="${publisher}" Language="en-US" />
    <DisplayName>Catppuccin Custom — Catppuccin Icons</DisplayName>
    <Description xml:space="preserve">Catppuccin file icon shapes using the Catppuccin Custom palette.</Description>
    <Categories>Themes</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.83.0" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`;
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": Buffer.from(contentTypes),
    "extension.vsixmanifest": Buffer.from(manifest),
  };
  for (const path of files(extension))
    entries[`extension/${relative(extension, path)}`] = readFileSync(path);
  writeFileSync(destination, zipSync(entries));
}

export function vscodeIcons(): void {
  const code = which("code");
  if (!code) return;
  const upstream = output([code, "--locate-extension", upstreamId]).trim();
  if (!upstream) return;
  if (!existsSync(upstream))
    throw new DotfilesError("Code reported a missing Catppuccin extension");
  // Invalidate the upstream activation sentinel when Hjem changes the palette
  rmSync(join(upstream, "themes/.flag"), { force: true });
  const temporary = mkdtempSync(join(dirname(upstream), `.${extensionId}-`));
  try {
    const extension = ensureDirectory(join(temporary, "extension"));
    writeJSON(join(extension, "theme.json"), buildTheme(upstream));
    for (const variant of ["dark", "light"] as const)
      copyIcons(
        join(upstream, "dist/unflavored"),
        join(extension, "icons", variant),
        palettes[variant],
      );
    const version = contentVersion(extension);
    writeJSON(join(extension, "package.json"), {
      name: customName,
      displayName: "Catppuccin Custom — Catppuccin Icons",
      description: "Catppuccin file icon shapes using the Catppuccin Custom palette.",
      version,
      publisher,
      engines: { vscode: "^1.83.0" },
      categories: ["Themes"],
      contributes: {
        iconThemes: [
          {
            id: customName,
            label: "Catppuccin Custom — Catppuccin Icons",
            path: "./theme.json",
          },
        ],
      },
    });
    const vsix = join(temporary, `${extensionId}-${version}.vsix`);
    buildVSIX(extension, vsix, version);
    run([code, "--install-extension", vsix, "--force"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
