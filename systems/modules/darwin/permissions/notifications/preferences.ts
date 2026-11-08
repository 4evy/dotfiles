import { or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { command, constant } from "@optique/core/primitives";
import { parseDarwinOptions } from "../../cli.ts";
import { parseInput } from "./protocol.ts";
import { run } from "./store.ts";

const parser = or(
  command("inspect", constant("inspect")),
  command("synchronize", constant("synchronize")),
  command("apply", constant("apply")),
  command("verify", constant("verify")),
);

async function main(): Promise<void> {
  const action = parseDarwinOptions(
    parser,
    "dotfiles-notifications",
    process.argv.slice(2),
    message`Inspect or reconcile macOS notification preferences`,
    message`Read JSON from standard input:
{suite,container,identifiers,grants:[{requiresAuth,setFlags,clearFlags}],baseline?}
Masks are decimal uint64 strings. verify reads physical plists and requires
baseline. Run inspect/synchronize/apply as the target user. Stop usernoted
and await its exit before synchronize or apply.`,
  );
  if (action === undefined) return;
  const input = parseInput(JSON.parse(await Bun.stdin.text()), action);
  run(action, input);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `dotfiles-notifications: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
