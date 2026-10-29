import { Schema, Struct } from "effect";

const CommandSchema = Schema.Array(Schema.String)
  .check(Schema.isMinLength(1))
  .pipe(Schema.mutable);

// Struct decoding strips unknown keys, matching the exported manifest contract
export const EntrySchema = Schema.Struct({
  type: Schema.Literals(["symlink", "copy"]),
  source: Schema.String,
  target: Schema.String,
  clobber: Schema.optionalKey(Schema.Boolean),
  permissions: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-7]{4}$/))),
  requireCommand: Schema.optionalKey(Schema.String),
}).mapFields(Struct.map(Schema.mutableKey));
export const ManifestSchema = Schema.Struct({
  version: Schema.Number,
  files: Schema.Array(EntrySchema).pipe(Schema.mutable),
}).mapFields(Struct.map(Schema.mutableKey));
export const HookSchema = Schema.Struct({
  command: CommandSchema,
  onchange: Schema.Boolean,
  name: Schema.String,
  inputs: Schema.optionalKey(Schema.Array(Schema.String)),
}).mapFields(Struct.map(Schema.mutableKey));
export const HooksSchema = Schema.Array(HookSchema).pipe(Schema.mutable);
export const GeneratorSchema = Schema.Struct({
  target: Schema.String,
  command: CommandSchema,
  systems: Schema.optionalKey(Schema.Array(Schema.String)),
  requireCommand: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Boolean),
}).mapFields(Struct.map(Schema.mutableKey));
export const GeneratorsSchema = Schema.Array(GeneratorSchema);
export const PreparedAiManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  platform: Schema.optionalKey(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      private: Schema.optionalKey(Schema.Boolean),
      type: Schema.optionalKey(Schema.Literals(["symlink", "copy"])),
    }),
  ).pipe(Schema.mutable),
});

export type Entry = typeof EntrySchema.Type;
export type Manifest = typeof ManifestSchema.Type;
export type Hook = typeof HookSchema.Type;
export type Generator = typeof GeneratorSchema.Type;
export type PreparedAiManifest = typeof PreparedAiManifestSchema.Type;
