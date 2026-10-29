#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { output } from "@dotfiles/core/commands";
import { DotfilesError } from "@dotfiles/core/errors";
import { runMain } from "@dotfiles/core/runtime";
import { Effect, FileSystem, Schema } from "effect";
import { prepareAiHome } from "./home.ts";

const root = resolve(import.meta.dir, "../../..");
const run = (argv: readonly string[], cwd = root, env = process.env) =>
  output(argv, { cwd, env, stderr: "inherit", stdin: "ignore" }).pipe(
    Effect.map((value) => value.trim()),
  );
const parseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) => new DotfilesError(`Invalid AI setup JSON: ${error}`),
  });
const LockSchema = Schema.Struct({
  root: Schema.String,
  nodes: Schema.Record(
    Schema.String,
    Schema.Struct({
      inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      locked: Schema.optionalKey(
        Schema.Struct({ rev: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});
const PrefetchSchema = Schema.Struct({ storePath: Schema.String });
const HostSchema = Schema.StructWithRest(
  Schema.Struct({
    farstep: Schema.mutableKey(Schema.optionalKey(Schema.String)),
    codexCli: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const actions = {
  apply: { generate: true, provisionFarstep: true },
  generate: { generate: true, provisionFarstep: true },
  setup: { generate: false, provisionFarstep: true },
  configure: { generate: false, provisionFarstep: false },
  activate: { generate: false, provisionFarstep: false },
};
const usage = "Usage: ai.ts [apply|generate|setup|configure|activate]";

runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const action = Bun.argv[2] ?? "apply";
    if (!Object.hasOwn(actions, action))
      return yield* Effect.fail(new DotfilesError(usage));
    const rules = actions[action as keyof typeof actions];
    const setupArguments = Bun.argv.slice(3);
    if (action !== "setup" && setupArguments.length)
      return yield* Effect.fail(
        new DotfilesError(`${action} does not accept arguments`),
      );
    if (action === "activate") {
      const home = homedir();
      yield* fs.makeDirectory(join(home, ".local/state/ghidra-mcp-headless"), {
        recursive: true,
        mode: 0o700,
      });
      if (process.platform === "linux" && Bun.which("systemctl")) {
        yield* run(["systemctl", "--user", "daemon-reload"]);
        const environment = join(home, ".config/environment.d/60-codex-cli.conf");
        if (yield* fs.exists(environment)) {
          const value = (yield* fs.readFileString(environment))
            .trim()
            .slice("CODEX_CLI_PATH=".length);
          const cli = yield* Schema.decodeUnknownEffect(Schema.String)(
            yield* parseJson(value),
          );
          const command = Bun.which("dbus-update-activation-environment")
            ? [
                "dbus-update-activation-environment",
                "--systemd",
                `CODEX_CLI_PATH=${cli}`,
              ]
            : ["systemctl", "--user", "set-environment", `CODEX_CLI_PATH=${cli}`];
          yield* run(command);
        }
        yield* run(["systemctl", "--user", "enable", "ghidra-mcp.service"]);
        yield* run(["systemctl", "--user", "restart", "ghidra-mcp.service"]);
      }
      return;
    }

    // Darwin activates user settings through its native module
    if (action === "apply" && process.platform !== "linux") return;
    const lock = yield* Schema.decodeUnknownEffect(LockSchema)(
      yield* parseJson(yield* fs.readFileString(join(root, "flake.lock"))),
    );
    const ai = lock.nodes[lock.root]?.inputs?.ai;
    const revision = typeof ai === "string" ? lock.nodes[ai]?.locked?.rev : undefined;
    if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision))
      return yield* Effect.fail(
        new DotfilesError("The AI input must lock a GitHub revision"),
      );
    const parent = join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
      "dotfiles/ai",
    );
    const source = join(parent, revision);
    const missingSource = !(yield* fs.exists(join(source, "flake.nix")));
    if (missingSource) {
      const prefetched = yield* Schema.decodeUnknownEffect(PrefetchSchema)(
        yield* parseJson(
          yield* run([
            "nix",
            "flake",
            "prefetch",
            "--json",
            "--inputs-from",
            root,
            "ai",
          ]),
        ),
      );
      yield* fs.makeDirectory(parent, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staging = yield* fs.makeTempDirectoryScoped({
            directory: parent,
            prefix: ".install-",
          });
          yield* fs.copy(prefetched.storePath, staging, { overwrite: true });
          yield* run(["chmod", "-R", "u+w", staging]);
          yield* fs.rename(staging, source);
        }),
      );
    }
    yield* run(
      [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
      source,
    );
    let farstepPackage = "";
    if (
      process.platform === "linux" &&
      !(yield* fs.exists("/etc/NIXOS")) &&
      rules.provisionFarstep
    ) {
      const state = join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
        "farstep",
      );
      yield* fs.makeDirectory(state, { recursive: true });
      farstepPackage = yield* run([
        "nix",
        "build",
        `${root}#farstep`,
        "--out-link",
        join(state, "package"),
        "--print-out-paths",
      ]);
    }
    if (action === "setup") {
      // The pinned AI checkout owns this SDK entry and its Promise-based API
      yield* run(
        [
          process.execPath,
          "--eval",
          'import { setup } from "./tools/scripts/setup/setup.ts"; await setup(Bun.argv.slice(1), { background: process.env.HJEM_ACTIVATING === "1" });',
          "codex",
          "claude",
          "opencode",
          ...setupArguments,
        ],
        source,
        { ...process.env, AI_TOOLS_FLAKE: root },
      );
    } else if (action === "configure") {
      yield* run(
        [process.execPath, "tools/scripts/cli/cli.ts", "chatgpt", "configure"],
        source,
      );
    } else if (rules.generate) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({
            prefix: "dotfiles-ai-configs-",
          });
          const hostFile = join(temporary, "host.json");
          const runtime = yield* run([
            "nix",
            "build",
            `${root}#ai-tools`,
            "--no-link",
            "--print-out-paths",
          ]);
          // Keep unknown host fields, which are inputs to the pinned AI renderer
          const host = yield* Schema.decodeUnknownEffect(HostSchema)(
            yield* parseJson(
              yield* run(
                [
                  process.execPath,
                  "config/settings/generate/generate.ts",
                  "--print-host",
                ],
                source,
              ),
            ),
          );
          host.farstep =
            (farstepPackage && join(farstepPackage, "bin/farstep")) ||
            (process.platform === "linux" &&
              Bun.which("/run/current-system/sw/bin/farstep")) ||
            join(source, "farstep/farstep");
          if (process.platform === "linux")
            host.codexCli = yield* run(
              [
                process.execPath,
                "--eval",
                'import { findBinary } from "./tools/scripts/setup/binary.ts"; console.log(findBinary("codex"));',
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
          const generated = join(root, ".generated");
          yield* fs.makeDirectory(generated, { recursive: true, mode: 0o700 });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const staging = yield* fs.makeTempDirectoryScoped({
                directory: generated,
                prefix: ".ai-configs-",
              });
              yield* prepareAiHome(
                source,
                exported,
                staging,
                host.codexCli ?? "",
                join(runtime, "bin/omp"),
                host.farstep,
              );
              const destination = join(generated, "ai-configs");
              const backup = join(generated, "ai-configs.previous");
              yield* fs.remove(backup, { recursive: true, force: true });
              // Once moved aside, restore the previous generation on rename failure
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const previous = yield* fs.exists(destination);
                  if (previous) yield* fs.rename(destination, backup);
                  yield* fs.rename(staging, destination).pipe(
                    Effect.catch((error) =>
                      Effect.gen(function* () {
                        if (previous) yield* fs.rename(backup, destination);
                        return yield* Effect.fail(error);
                      }),
                    ),
                  );
                  yield* fs.remove(backup, { recursive: true, force: true });
                }),
              );
            }),
          );
        }),
      );
      if (action === "apply")
        yield* run(
          [process.execPath, join(root, "home/deploy/apply.ts"), "apply"],
          root,
          { ...process.env, DOTFILES_AI_PREPARED: "1" },
        );
    }
  }),
);
