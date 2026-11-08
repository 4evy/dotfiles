import { DotfilesError } from "@dotfiles/core/errors";
import { type RuntimeServices, runMain } from "@dotfiles/core/runtime";
import { or, seq } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { message } from "@optique/core/message";
import { map, optional } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect, Exit, type PlatformError } from "effect";
import { deploy } from "./deploy.ts";
import { writeOutput } from "./files.ts";
import {
  check,
  editSource,
  editWorkspace,
  layout,
  packSource,
  unpackSource,
} from "./source.ts";
import { Vault } from "./vault.ts";
import { packWorkspace, unpackWorkspace } from "./workspace.ts";

type Operation = (
  vault: Vault,
) => Effect.Effect<void, DotfilesError | PlatformError.PlatformError, RuntimeServices>;

function selectOperation(args: string[]) {
  let operation: Operation | undefined;
  let stdout = "";
  let stderr = "";
  let status = 0;
  let completed = false;
  const path = optional(argument(string({ metavar: "PATH" })));
  const parser = or(
    command(
      "deploy",
      map(
        optional(option("--directory", string({ metavar: "PATH" }))),
        (directory): Operation =>
          (vault) =>
            deploy(vault, directory ?? ""),
      ),
      {
        description: message`Decrypt records into protected runtime files for Hjem`,
      },
    ),
    command(
      "unpack",
      map(
        path,
        (directory): Operation =>
          (vault) =>
            directory === undefined
              ? unpackSource(vault)
              : unpackWorkspace(vault, directory),
      ),
      {
        description: message`Materialize records or decrypt a protected workspace`,
      },
    ),
    command(
      "pack",
      map(
        path,
        (directory): Operation =>
          (vault) =>
            directory === undefined
              ? packSource(vault)
              : packWorkspace(vault, directory),
      ),
      {
        description: message`Re-encrypt materialized records or a protected workspace`,
      },
    ),
    command(
      "check",
      map(
        path,
        (directory): Operation =>
          (vault) =>
            check(vault, directory ?? ""),
      ),
      {
        description: message`Validate the vault, records, or a protected workspace`,
      },
    ),
    command(
      "edit",
      map(
        path,
        (target): Operation =>
          (vault) =>
            editSource(vault, target ?? ""),
      ),
      {
        description: message`Materialize and edit the source tree or one record`,
      },
    ),
    command("layout", constant(layout), {
      description: message`Show target-to-source mappings and attributes`,
    }),
    command(
      "workspace-edit",
      map(
        seq(
          optional(argument(string({ metavar: "COLLECTION" }))),
          optional(argument(string({ metavar: "INDEX" }))),
        ),
        ([collection, index]): Operation =>
          (vault) =>
            editWorkspace(vault, collection ?? "", index ?? ""),
      ),
      { hidden: true },
    ),
  );
  const selected = runParser(parser, "records", args.length ? args : ["--help"], {
    brief: message`Manage encrypted dotfile records`,
    help: {
      option: { names: ["-h", "--help"] },
      command: true,
      onShow: () => {
        completed = true;
      },
    },
    onError: () => {
      completed = true;
      status = 1;
    },
    stdout: (text) => {
      stdout += `${text}\n`;
    },
    stderr: (text) => {
      stderr += `${text}\n`;
    },
  });
  if (!completed) operation = selected;
  return { operation, stdout, stderr, status };
}

const main = Effect.gen(function* () {
  const selection = yield* Effect.try({
    try: () => selectOperation(process.argv.slice(2)),
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
