import { or } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { formatMessage, message } from "@optique/core/message";
import { command, constant } from "@optique/core/primitives";
import { parseInput } from "./protocol.ts";
import { run } from "./store.ts";

const parser = or(
  command("inspect", constant("inspect")),
  command("synchronize", constant("synchronize")),
  command("apply", constant("apply")),
  command("verify", constant("verify")),
);

async function main(): Promise<void> {
  let helpShown = false;
  const action = runParser(parser, "dotfiles-notifications", process.argv.slice(2), {
    brief: message`Inspect or reconcile macOS notification preferences`,
    description: message`Read JSON from standard input:
{suite,container,identifiers,grants:[{requiresAuth,setFlags,clearFlags}],baseline?}
Masks are decimal uint64 strings. verify reads physical plists and requires
baseline. Run inspect/synchronize/apply as the target user. Stop usernoted
and await its exit before synchronize or apply.`,
    help: {
      option: { names: ["-h", "--help"] },
      onShow: () => {
        helpShown = true;
      },
    },
    stderr: () => {},
    onError: (_code, error) => {
      throw new Error(formatMessage(error));
    },
  });
  if (helpShown) return;
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
