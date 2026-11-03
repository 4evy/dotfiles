import { parseInput } from "./protocol.ts";
import { run } from "./store.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(
      "Usage: dotfiles-notifications inspect|synchronize|apply|verify < input.json\n" +
        "Input: {suite,container,identifiers,grants:[{requiresAuth,setFlags,clearFlags}],baseline?}\n" +
        "Masks are decimal uint64 strings. verify reads physical plists and requires baseline.\n" +
        "Run inspect/synchronize/apply as the target user.\n" +
        "Stop usernoted and await its exit before synchronize or apply.",
    );
    return;
  }
  const action = args[0];
  if (
    args.length !== 1 ||
    (action !== "inspect" &&
      action !== "synchronize" &&
      action !== "apply" &&
      action !== "verify")
  ) {
    throw new Error(
      "Expected inspect, synchronize, apply, or verify; use --help for the JSON protocol",
    );
  }
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
