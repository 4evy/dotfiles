import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import type { Connections } from "../connections/state";
import type { Connection } from "../connections/types";
import type { RemoteJobs } from "../jobs";
import { helperStatus } from "./helper";
import {
  activationCommand,
  currentHelper,
  installationPlan,
  MANAGER_OWNERS,
  type Request,
} from "./plan";
import { inspectPlatform, remoteCommand } from "./platform";
import { installWithSudo } from "./sudo";

const maintenanceTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const PACKAGE_TIMEOUT_SECONDS = 600;
const ACTIVATION_TIMEOUT_MS = 60_000;
const ARTIFACT_POLICY =
  "Build for the target distribution/release/architecture, transfer using SSH, then provide its absolute remote path and SHA-256. Use plan before mutation.";
const RECOVERY = {
  transaction: {
    gated:
      "Package transaction failed or its outcome is unknown. Inspect the package database; resume upgrade with this maintenanceToken, or restore the old package and use action upgrade with subcommand cancel. The maintenance gate remains closed.",
    ungated:
      "The package transaction failed or its outcome is unknown. Inspect the package database before retrying; per-user activation has not been completed.",
  },
  activation: {
    gated:
      "Maintenance remains gated. Inspect package state and resume upgrade with this token; action upgrade with subcommand cancel is safe only after the original package is restored.",
    ungated:
      "Inspect package state before retrying; a successful package transaction is not undone when activation fails.",
  },
} as const;

export interface HelperInput extends Request {
  connection: string;
  subcommand?: "cancel" | undefined;
  password?: string | undefined;
  timeout?: number | undefined;
}

function result(details: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

type InstallationPlan = ReturnType<typeof installationPlan>;

async function assertOperation(
  connection: Connection,
  args: HelperInput,
  plan: InstallationPlan,
  signal?: AbortSignal,
): Promise<void> {
  const before = args.maintenanceToken
    ? undefined
    : await helperStatus(connection, signal);
  if (!args.maintenanceToken) {
    if (args.action === "install" && before?.installed)
      throw new Error(
        "Helper is already activated; use upgrade so live work is quiesced before package replacement",
      );
    if (args.action === "upgrade" && !before?.installed)
      throw new Error("Helper is not activated; use install");
  }
  const owner = MANAGER_OWNERS[plan.manager];
  if (before?.installed && before.manager !== undefined && before.manager !== owner)
    throw new Error(
      "Changing package-manager ownership requires an explicit uninstall first",
    );
}

async function transactPackage(
  connection: Connection,
  args: HelperInput,
  plan: InstallationPlan,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
) {
  if (!plan.packageCommand) return undefined;
  const timeout = args.timeout ?? PACKAGE_TIMEOUT_SECONDS;
  if (!plan.privileged) {
    await remoteCommand(connection, plan.packageCommand, signal, timeout * 1000);
    return undefined;
  }
  return installWithSudo(
    connection,
    {
      command: plan.packageCommand,
      cwd: connection.cwd,
      timeout,
      ...(args.password === undefined ? {} : { password: args.password }),
    },
    ctx,
    signal,
    onUpdate,
  );
}

async function refreshHelper(
  connection: Connection,
  save: Connections["save"],
  signal?: AbortSignal,
): Promise<void> {
  connection.helper = await helperStatus(connection, signal);
  save(connection);
}

export async function manageHelper(
  args: HelperInput,
  { selected, save }: Connections,
  jobs: RemoteJobs,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
) {
  if (args.subcommand && args.action !== "upgrade")
    throw new Error("subcommand cancel is only valid with action upgrade");
  const connection = selected(args.connection);
  const platform = await inspectPlatform(connection, signal);
  if (args.action === "inspect") {
    const status = await helperStatus(connection, signal);
    connection.helper = status;
    save(connection);
    return result({
      platform,
      status,
      artifactPolicy: ARTIFACT_POLICY,
    });
  }
  if (args.action === "upgrade" && args.subcommand === "cancel") {
    if (!args.maintenanceToken)
      throw new Error("upgrade cancel requires the returned maintenanceToken");
    const status = JSON.parse(
      await remoteCommand(
        connection,
        activationCommand(currentHelper, ["upgrade", "cancel"], {
          maintenanceToken: args.maintenanceToken,
        }),
        signal,
      ),
    );
    await refreshHelper(connection, save, signal);
    return result({ platform, status });
  }
  let request: Request = { ...args, action: args.action };
  let plan = installationPlan(platform, request);
  if (args.action === "plan") return result({ platform, plan });
  await assertOperation(connection, args, plan, signal);
  let maintenanceToken = args.maintenanceToken;
  try {
    if (plan.prepare) {
      const prepared = JSON.parse(
        await remoteCommand(connection, plan.prepare, signal),
      );
      maintenanceToken = maintenanceTokenSchema.parse(prepared.maintenanceToken);
      if (!maintenanceToken) throw new Error("Helper returned no maintenance token");
      request = { ...request, maintenanceToken };
      plan = installationPlan(platform, request);
    }
    if (maintenanceToken) await jobs.disconnect(connection);
    let status: unknown;
    if (args.action === "uninstall") {
      status = JSON.parse(await remoteCommand(connection, plan.activation, signal));
      await jobs.disconnect(connection);
    }
    const transaction = await transactPackage(
      connection,
      args,
      plan,
      ctx,
      signal,
      onUpdate,
    );
    if (transaction?.isError) {
      return result(
        {
          platform,
          plan,
          status,
          transaction,
          maintenanceToken,
          recovery: RECOVERY.transaction[maintenanceToken ? "gated" : "ungated"],
        },
        true,
      );
    }
    if (args.action !== "uninstall")
      status = JSON.parse(
        await remoteCommand(connection, plan.activation, signal, ACTIVATION_TIMEOUT_MS),
      );
    await refreshHelper(connection, save, signal);
    if (args.action === "upgrade") await jobs.disconnect(connection);
    return result({ platform, plan, status });
  } catch (error) {
    return result(
      {
        platform,
        plan,
        maintenanceToken,
        error: error instanceof Error ? error.message : String(error),
        recovery: RECOVERY.activation[maintenanceToken ? "gated" : "ungated"],
      },
      true,
    );
  }
}
