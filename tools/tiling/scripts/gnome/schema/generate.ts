import { fileURLToPath } from "node:url";
import bindings from "@dotfiles/tiling/bindings" with { type: "json" };
import metadata from "@dotfiles/tiling/gnome/metadata" with { type: "json" };
import { LAYOUT_PRESET_NAMES } from "@dotfiles/tiling/shared";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { object } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { withDefault } from "@optique/core/modifiers";
import { flag } from "@optique/core/primitives";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const text = Schema.String.check(Schema.isMinLength(1));
const descriptions = {
  kde: Schema.Struct({ title: text, accelerator: text }),
  gnome: Schema.Struct({ summary: text, accelerator: text }),
};
const binding = Schema.Union([
  Schema.Struct({
    ...descriptions,
    action: Schema.Literal("cycle"),
    presets: Schema.NonEmptyArray(Schema.Literals(LAYOUT_PRESET_NAMES)),
  }),
  Schema.Struct({
    ...descriptions,
    action: Schema.Literal("maximize"),
    presets: Schema.Tuple([]),
  }),
]);
const policy = Schema.Struct({
  "move-up": binding,
  "move-left": binding,
  "move-down": binding,
  "move-right": binding,
  "move-max-almost": binding,
  "move-max": binding,
});

const options = runParser(
  object({ check: withDefault(flag("--check"), false) }),
  "generate-tiling-schema",
  Bun.argv.slice(2),
  {
    help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
    onError: process.exit,
  },
);

const program = Effect.gen(function* () {
  const validated = yield* Schema.decodeUnknownEffect(policy, {
    onExcessProperty: "error",
  })(bindings);
  const { "settings-schema": schemaId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ "settings-schema": text }),
  )(metadata);
  // KDE validates the same policy without importing platform code at runtime
  if (options.check) return;

  const xml = renderSchema(schemaId, validated);
  const fs = yield* FileSystem.FileSystem;
  const schemas = fileURLToPath(
    new URL("../../../dist/gnome/schemas/", import.meta.url),
  );
  yield* fs.makeDirectory(schemas, { recursive: true });
  yield* fs.writeFileString(`${schemas}${schemaId}.gschema.xml`, xml);
});

BunRuntime.runMain(program.pipe(Effect.provide(BunFileSystem.layer)));

function renderSchema(schemaId: string, bindings: typeof policy.Type): string {
  const schemaPath = `/${schemaId.replaceAll(".", "/")}/`;
  const keys = Object.entries(bindings).map(([name, { gnome }]) => {
    const accelerator = gnome.accelerator
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'");
    return `    <key name="${escapeXml(name)}" type="as">
      <default>${escapeXml(`['${accelerator}']`)}</default>
      <summary>${escapeXml(gnome.summary)}</summary>
    </key>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="${escapeXml(schemaId)}" path="${escapeXml(schemaPath)}">
${keys.join("\n")}
  </schema>
</schemalist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
