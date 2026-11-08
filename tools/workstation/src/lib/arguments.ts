import { or } from "@optique/core/constructs";
import { map, multiple } from "@optique/core/modifiers";
import { argument, passThrough } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";

export const forwardedArguments = multiple(
  or(
    map(argument(string()), (value) => [value]),
    passThrough({ format: "nextToken" }),
  ),
);
