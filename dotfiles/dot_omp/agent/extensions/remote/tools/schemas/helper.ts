import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MANAGERS } from "../../helper/platform";

export function createHelperParameters(api: ExtensionAPI) {
  const z = api.zod;
  const tokenSchema = z
    .string()
    .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  const parameters = z.object({
    connection: z.string().min(1),
    action: z.enum(["inspect", "plan", "install", "upgrade", "uninstall"]),
    subcommand: z
      .literal("cancel")
      .optional()
      .describe(
        "Use action upgrade with subcommand cancel to restore a prepared upgrade",
      ),
    operation: z
      .enum(["install", "upgrade", "uninstall"])
      .optional()
      .describe("Operation to preview with action plan; defaults to install"),
    manager: z
      .enum(MANAGERS)
      .optional()
      .describe(
        "Default: detected native manager, existing Nix on immutable Linux, or Homebrew on macOS",
      ),
    artifact: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute remote path to a deb/rpm/pkg.tar.zst, Darwin tar.gz payload, or realized Nix store output; no downloads",
      ),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/u)
      .optional()
      .describe("Expected artifact SHA-256, required for native package installation"),
    waylandDisplay: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/u)
      .optional(),
    maintenanceToken: tokenSchema
      .optional()
      .describe(
        "Upgrade recovery token; inspect package state before resuming, restore the old package before cancelling",
      ),
    password: z
      .string()
      .optional()
      .describe(
        "Optional sudo password; otherwise checks /etc/bleh, then asks for plaintext input",
      ),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Package transaction budget in seconds; default 600"),
  });
  return { parameters };
}
