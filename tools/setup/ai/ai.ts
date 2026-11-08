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
import { choice } from "@optique/core/valueparser";
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
      map(
        argument(choice(["apply", "generate", "configure", "activate"])),
        (action) => ({ action, setupArguments: [] }),
      ),
    ),
    { action: "apply", setupArguments: [] },
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

const installAiSource = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
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
        yield* run(["nix", "flake", "prefetch", "--json", "--inputs-from", root, "ai"]),
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
  return source;
});

const provisionFarstep = Effect.fn(function* (enabled: boolean) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform !== "linux" || (yield* fs.exists("/etc/NIXOS")) || !enabled)
    return "";
  const state = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
    "farstep",
  );
  yield* fs.makeDirectory(state, { recursive: true });
  return yield* run([
    "nix",
    "build",
    `${root}#farstep`,
    "--out-link",
    join(state, "package"),
    "--print-out-paths",
  ]);
});

const publishAiConfigs = (
  source: string,
  exported: string,
  nativeCli: string,
  omp: string,
  farstep: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const generated = join(root, ".generated");
      yield* fs.makeDirectory(generated, {
        recursive: true,
        mode: privateDirectoryMode,
      });
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: generated,
        prefix: ".ai-configs-",
      });
      yield* prepareAiHome(source, exported, staging, nativeCli, omp, farstep);
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

const generateAiConfigs = (source: string, farstepPackage: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
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
            [process.execPath, "config/settings/generate/generate.ts", "--print-host"],
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
      yield* publishAiConfigs(
        source,
        exported,
        host.codexCli ?? "",
        join(runtime, "bin/omp"),
        host.farstep,
      );
    }),
  );

runMain(
  Effect.gen(function* () {
    const { action, setupArguments } = selected;
    const rules = actions[action];
    if (action === "activate") {
      yield* activateAi;
      return;
    }

    // Darwin activates user settings through its native module
    if (action === "apply" && process.platform !== "linux") return;
    const source = yield* installAiSource;
    const farstepPackage = yield* provisionFarstep(rules.provisionFarstep);
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
      yield* generateAiConfigs(source, farstepPackage);
      if (action === "apply")
        yield* run(
          [process.execPath, join(root, "home/deploy/apply.ts"), "apply"],
          root,
          { ...process.env, DOTFILES_AI_PREPARED: "1" },
        );
    }
  }),
);
