#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { output } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { object, or } from "@optique/core/constructs";
import { runParser } from "@optique/core/facade";
import { map, withDefault } from "@optique/core/modifiers";
import { argument, command, constant, passThrough } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { Effect, FileSystem, Schema } from "effect";
import { prepareAiHome } from "./home.ts";

const root = resolve(import.meta.dir, "../../..");
const privateDirectoryMode = 0o700;
const ghidraService = "ghidra-mcp.service";
const codexCliAssignment = "CODEX_CLI_PATH=";
const run = (argv: readonly string[], cwd = root, env = process.env) =>
  output(argv, { cwd, env, stderr: "inherit", stdin: "ignore" }).pipe(
    Effect.map((value) => value.trim()),
  );
const parseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) => new DotfilesError(`Invalid AI setup JSON: ${error}`),
  });
const HostSchema = Schema.StructWithRest(
  Schema.Struct({
    farstep: Schema.mutableKey(Schema.optionalKey(Schema.String)),
    codexCli: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const selected = runParser(
  withDefault(
    or(
      command(
        "setup",
        object({
          action: constant("setup"),
          setupArguments: passThrough({ format: "greedy" }),
        }),
      ),
      command(
        "generate",
        object({
          action: constant("generate"),
          destination: argument(string({ metavar: "DIRECTORY" })),
        }),
      ),
      map(argument(choice(["apply", "configure", "activate"])), (action) => ({
        action,
      })),
    ),
    { action: "apply" },
  ),
  "ai.ts",
  Bun.argv.slice(2),
  {
    help: { option: { names: ["-h", "--help"] }, onShow: process.exit },
    onError: process.exit,
  },
);

const activateAi = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = homedir();
  yield* fs.makeDirectory(join(home, ".local/state/ghidra-mcp-headless"), {
    recursive: true,
    mode: privateDirectoryMode,
  });
  if (process.platform === "linux" && Bun.which("systemctl")) {
    yield* run(["systemctl", "--user", "daemon-reload"]);
    const environment = join(home, ".config/environment.d/60-codex-cli.conf");
    if (yield* fs.exists(environment)) {
      const value = (yield* fs.readFileString(environment))
        .trim()
        .slice(codexCliAssignment.length);
      const cli = yield* Schema.decodeUnknownEffect(Schema.String)(
        yield* parseJson(value),
      );
      const command = Bun.which("dbus-update-activation-environment")
        ? [
            "dbus-update-activation-environment",
            "--systemd",
            `${codexCliAssignment}${cli}`,
          ]
        : ["systemctl", "--user", "set-environment", `${codexCliAssignment}${cli}`];
      yield* run(command);
    }
    yield* run(["systemctl", "--user", "enable", ghidraService]);
    yield* run(["systemctl", "--user", "restart", ghidraService]);
  }
});

const buildPackage = (name: "ai-tools" | "farstep", outLink: string) =>
  run(["nix", "build", `${root}#${name}`, "--out-link", outLink, "--print-out-paths"]);

const provisionFarstep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform !== "linux" || (yield* fs.exists("/etc/NIXOS"))) return;
  const state = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
    "farstep",
  );
  yield* fs.makeDirectory(state, { recursive: true });
  yield* buildPackage("farstep", join(state, "package"));
});

const generateAiConfigs = (destination: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(destination, { mode: privateDirectoryMode });
      // The generation must keep its immutable launcher targets alive
      const runtime = yield* buildPackage("ai-tools", join(destination, ".runtime"));
      const source = join(runtime, "lib/ai-tools");
      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: "dotfiles-ai-configs-",
      });
      const hostFile = join(temporary, "host.json");
      const systemFarstep =
        process.platform === "darwin" || (yield* fs.exists("/etc/NIXOS"));
      const farstep =
        (systemFarstep && Bun.which("/run/current-system/sw/bin/farstep")) ||
        join(
          yield* buildPackage("farstep", join(destination, ".farstep")),
          "bin/farstep",
        );
      // Keep unknown host fields, which are inputs to the pinned AI renderer
      const host = yield* Schema.decodeUnknownEffect(HostSchema)(
        yield* parseJson(
          yield* run(
            [process.execPath, "config/settings/generate/generate.js", "--print-host"],
            source,
          ),
        ),
      );
      host.farstep = farstep;
      if (process.platform === "linux")
        host.codexCli = yield* run(
          [
            process.execPath,
            "--eval",
            'import { findBinary } from "./tools/scripts/setup/binary.js"; console.log(findBinary("codex", Bun.argv[1]));',
            join(runtime, "bin/codex"),
          ],
          source,
        );
      yield* fs.writeFileString(hostFile, JSON.stringify(host));
      const argument = JSON.stringify(
        JSON.stringify({
          system: `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform}`,
          hostFile,
        }),
      ).replaceAll("${", "\\${");
      const derivation = yield* run([
        "nix",
        "eval",
        "--impure",
        "--raw",
        `${root}#lib.aiConfigs`,
        "--apply",
        `build: (build ${argument}).drvPath`,
      ]);
      const exported = yield* run([
        "nix",
        "build",
        `${derivation}^*`,
        "--no-link",
        "--print-out-paths",
      ]);
      yield* prepareAiHome(
        runtime,
        exported,
        destination,
        host.codexCli ?? "",
        farstep,
      );
    }),
  );

runMain(
  Effect.scoped(
    Effect.gen(function* () {
      if (selected.action === "activate") return yield* activateAi;
      if (selected.action === "generate")
        return yield* generateAiConfigs(resolve(selected.destination));
      if (selected.action === "apply") {
        // Darwin activates user settings through its native module
        if (process.platform === "linux")
          yield* run([process.execPath, "home/deploy/apply.ts", "apply"]);
        return;
      }

      const fs = yield* FileSystem.FileSystem;
      // Setup and app configuration do not deploy links into this package
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-ai-" });
      const runtime = yield* buildPackage("ai-tools", join(temporary, "runtime"));
      if (selected.action === "setup") {
        yield* provisionFarstep;
        yield* run(
          [
            process.execPath,
            "--eval",
            'import { setup } from "./tools/scripts/setup/setup.js"; await setup(Bun.argv.slice(1), { background: process.env.HJEM_ACTIVATING === "1" });',
            "codex",
            "claude",
            "opencode",
            ...selected.setupArguments,
          ],
          join(runtime, "lib/ai-tools"),
          { ...process.env, AI_TOOLS_FLAKE: root },
        );
      } else {
        yield* run(
          [
            process.execPath,
            join(runtime, "lib/ai-tools/apps/chatgpt/configure/configure.js"),
          ],
          root,
          { ...process.env, AI_TOOLS_WRAPPER_BIN: join(runtime, "bin/ai") },
        );
      }
    }),
  ),
);
