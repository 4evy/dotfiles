import { DotfilesError } from "@dotfiles/core/errors";
import { type RuntimeServices, runMain } from "@dotfiles/core/runtime";
import { Command, CommanderError } from "commander";
import { Effect, Exit, type PlatformError } from "effect";
import { deploy } from "./deploy.ts";
import { writeOutput } from "./files.ts";
import {
  editSource,
  editWorkspace,
  layout,
  packSource,
  unpackSource,
} from "./source.ts";
import { Vault } from "./vault.ts";
import { check, packWorkspace, unpackWorkspace } from "./workspace.ts";

type Operation = (
  vault: Vault,
) => Effect.Effect<void, DotfilesError | PlatformError.PlatformError, RuntimeServices>;

function selectOperation(args: string[]) {
  let operation: Operation | undefined;
  let stdout = "";
  let stderr = "";
  let status = 0;
  const program = new Command()
    .name("records")
    .description("Manage encrypted dotfile records")
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
    });
  program
    .command("deploy")
    .description("Decrypt records into protected runtime files for Hjem")
    .option(
      "--directory <path>",
      "Protected runtime root (defaults to XDG_STATE_HOME/hjem/records)",
    )
    .action((options: { directory?: string }) => {
      operation = (vault) => deploy(vault, options.directory ?? "");
    });
  program
    .command("unpack [directory]")
    .description("Materialize records or decrypt them into a protected workspace")
    .action((directory?: string) => {
      operation = (vault) =>
        directory === undefined
          ? unpackSource(vault)
          : unpackWorkspace(vault, directory);
    });
  program
    .command("pack [directory]")
    .description("Re-encrypt materialized records or a protected workspace")
    .action((directory?: string) => {
      operation = (vault) =>
        directory === undefined ? packSource(vault) : packWorkspace(vault, directory);
    });
  program
    .command("check [directory]")
    .description("Validate the vault, materialized records, or a protected workspace")
    .action((directory?: string) => {
      operation = (vault) => check(vault, directory ?? "");
    });
  program
    .command("edit [path]")
    .description("Materialize and edit the source tree or one record")
    .action((path?: string) => {
      operation = (vault) => editSource(vault, path ?? "");
    });
  program
    .command("layout")
    .description("Show target-to-source mappings and attributes")
    .action(() => {
      operation = layout;
    });
  program
    .command("workspace-edit [collection] [index]", { hidden: true })
    .description("Edit records in a temporary protected workspace")
    .action((collection?: string, index?: string) => {
      operation = (vault) => editWorkspace(vault, collection ?? "", index ?? "");
    });
  program.action(() => program.outputHelp());
  try {
    program.parse(args);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    status = error.exitCode === 0 ? 0 : 1;
  }
  return { operation, stdout, stderr, status };
}

const main = Effect.gen(function* () {
  const selection = yield* Effect.try({
    try: () => selectOperation(process.argv),
    catch: () => new DotfilesError("parse records command failed"),
  });
  if (selection.stdout) yield* writeOutput("stdout", selection.stdout);
  if (selection.stderr) yield* writeOutput("stderr", selection.stderr);
  if (selection.status !== 0) {
    yield* Effect.sync(() => {
      process.exitCode = selection.status;
    });
    return;
  }
  if (selection.operation) yield* selection.operation(yield* Vault.create());
}).pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* writeOutput("stderr", `records: error: ${error.message}\n`);
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }),
  ),
);

runMain(main, {
  teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) ? 0 : 1),
});
