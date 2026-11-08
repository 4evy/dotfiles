import { runParser } from "@optique/core/facade";
import { formatMessage, type Message } from "@optique/core/message";
import type { InferValue, Parser } from "@optique/core/parser";

// Help completes without running the command, while parse errors reach its handler
export function parseDarwinOptions<P extends Parser<"sync", unknown, unknown>>(
  parser: P,
  programName: string,
  args: readonly string[],
  brief: Message,
  description?: Message,
): InferValue<P> | undefined {
  let helpShown = false;
  const values = runParser(parser, programName, args, {
    brief,
    ...(description === undefined ? {} : { description }),
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
  return helpShown ? undefined : values;
}
