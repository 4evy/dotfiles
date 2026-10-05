import { z } from "zod";
import { PROTOCOL_MAJOR } from "../state";
export const storePath = z
  .string()
  .regex(/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/u);
export const manifestSchema = z.strictObject({
  protocolMajor: z.literal(PROTOCOL_MAJOR),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  platform: z.literal("linux"),
  desktopExecutable: z.literal("bin/omp-helper-desktop"),
});
const ownedFile = z.strictObject({ path: z.string(), sha256: z.string() });
export const nativePath = z
  .string()
  .regex(/^\/(?:opt|usr\/lib)\/omp-helper\/\d+\.\d+\.\d+$/u);
export const packageIdentitySchema = z.strictObject({
  version: z.string().regex(/^\S+$/u),
  architecture: z.string().regex(/^\S+$/u),
});
const generationSchema = z.discriminatedUnion("manager", [
  z.strictObject({
    manager: z.literal("nix"),
    packagePath: storePath,
    version: z.string(),
    root: z.string(),
  }),
  z.strictObject({
    manager: z.enum(["dpkg", "rpm", "pacman"]),
    packagePath: nativePath,
    version: z.string(),
    packageIdentity: packageIdentitySchema,
  }),
]);
export const recordSchema = z.strictObject({
  version: z.literal(2),
  current: generationSchema,
  previous: generationSchema.optional(),
  files: z.array(ownedFile),
});
export const preparationSchema = z.strictObject({
  version: z.literal(1),
  maintenanceToken: z.uuid(),
  original: generationSchema,
  wasActive: z.boolean(),
  wasEnabled: z.boolean(),
});
export type InstallationRecord = z.infer<typeof recordSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type Manager = Generation["manager"];
export type Preparation = z.infer<typeof preparationSchema>;
export type PackageIdentity = z.infer<typeof packageIdentitySchema>;
