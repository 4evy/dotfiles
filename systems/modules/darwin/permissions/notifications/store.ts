import { join } from "node:path";
import { type Pointer, withCoreFoundation } from "./core-foundation.ts";
import { type Action, type Input, string, wantedFlags } from "./protocol.ts";

type App = { value: Pointer; identifier: string; flags: bigint; auth: bigint };

export function run(action: Action, input: Input): void {
  withCoreFoundation((foundation) => {
    const {
      cf,
      types,
      user,
      host,
      own,
      size,
      createString,
      requireType,
      readString,
      readNumber,
      createNumber,
      readPropertyList,
    } = foundation;
    const suite = createString(input.suite);
    // The private preferences API takes the container path as a CFString
    const container = createString(input.container);
    const keys = {
      apps: createString("apps"),
      identifier: createString("bundle-id"),
      flags: createString("flags"),
      auth: createString("auth"),
    };
    const selected = new Set(input.identifiers);

    function apps(value: Pointer | null, source: string): App[] {
      if (value === null) return [];
      requireType(value, types.array, `${source} apps`);
      const count = size(cf.CFArrayGetCount(value), `${source} apps`);
      const result: App[] = [];
      const identifiers = new Set<string>();
      for (let index = 0; index < count; index++) {
        const label = `${source} apps[${index}]`;
        const entry = requireType(
          cf.CFArrayGetValueAtIndex(value, BigInt(index)),
          types.dictionary,
          label,
        );
        const identifier = string(
          readString(
            cf.CFDictionaryGetValue(entry, keys.identifier),
            `${label} bundle-id`,
          ),
          `${label} bundle-id`,
        );
        if (identifiers.has(identifier))
          throw new Error(`${label} has a duplicate bundle-id`);
        identifiers.add(identifier);
        const auth = cf.CFDictionaryGetValue(entry, keys.auth);
        result.push({
          value: entry,
          identifier,
          flags: readNumber(
            cf.CFDictionaryGetValue(entry, keys.flags),
            `${label} flags`,
          ),
          auth: auth === null ? 0n : readNumber(auth, `${label} auth`),
        });
      }
      return result;
    }

    function replacement(app: App, flags: bigint): Pointer {
      const dictionary = own(
        cf.CFDictionaryCreateMutableCopy(null, 0n, app.value),
        "app dictionary copy",
      );
      cf.CFDictionarySetValue(dictionary, keys.flags, createNumber(flags));
      return dictionary;
    }

    if (action === "verify") {
      const before = apps(
        cf.CFDictionaryGetValue(
          readPropertyList(input.baseline as string, "Baseline"),
          keys.apps,
        ),
        "Baseline",
      );
      const after = apps(
        cf.CFDictionaryGetValue(
          readPropertyList(
            join(input.container, "Library", "Preferences", `${input.suite}.plist`),
            "Current",
          ),
          keys.apps,
        ),
        "Current",
      );
      const shared = Math.min(before.length, after.length);
      let outOfScopeChanges = Math.abs(before.length - after.length);
      let managedChanges = 0;
      for (let index = 0; index < shared; index++) {
        const original = before[index] as App;
        const current = after[index] as App;
        if (original.identifier !== current.identifier) {
          outOfScopeChanges++;
          continue;
        }
        if (!selected.has(original.identifier)) {
          if (!cf.CFEqual(original.value, current.value)) outOfScopeChanges++;
          continue;
        }
        if (original.flags !== current.flags) managedChanges++;
        const expected = wantedFlags(original, input.grants);
        const expectedValue =
          expected === original.flags
            ? original.value
            : replacement(original, expected);
        if (!cf.CFEqual(expectedValue, current.value)) outOfScopeChanges++;
      }
      console.log(JSON.stringify({ outOfScopeChanges, managedChanges }));
      if (outOfScopeChanges !== 0) {
        throw new Error(
          `Verification found ${outOfScopeChanges} app entries outside the policy transform`,
        );
      }
      return;
    }

    // Caller stops usernoted and awaits its old PID before synchronize or apply
    if (
      action === "synchronize" &&
      !cf._CFPreferencesSynchronizeWithContainer(suite, user, host, container)
    ) {
      throw new Error("Cannot synchronize notification preferences before backup");
    }
    const copied = cf._CFPreferencesCopyValueWithContainer(
      keys.apps,
      suite,
      user,
      host,
      container,
    );
    if (copied !== null) own(copied, "apps preferences");
    const current = apps(copied, "Current");
    const registered = new Set<string>();
    const changes: {
      identifier: string;
      beforeFlags: string;
      afterFlags: string;
    }[] = [];
    let updated: Pointer | null = null;
    for (let index = 0; index < current.length; index++) {
      const app = current[index] as App;
      if (!selected.has(app.identifier)) continue;
      registered.add(app.identifier);
      const flags = wantedFlags(app, input.grants);
      if (flags === app.flags) continue;
      changes.push({
        identifier: app.identifier,
        beforeFlags: app.flags.toString(),
        afterFlags: flags.toString(),
      });
      if (action === "apply") {
        updated ??= own(
          cf.CFArrayCreateMutableCopy(null, 0n, copied),
          "apps array copy",
        );
        cf.CFArraySetValueAtIndex(updated, BigInt(index), replacement(app, flags));
      }
    }
    if (updated !== null) {
      cf._CFPreferencesSetValueWithContainer(
        keys.apps,
        updated,
        suite,
        user,
        host,
        container,
      );
      if (!cf._CFPreferencesSynchronizeWithContainer(suite, user, host, container)) {
        throw new Error("Cannot synchronize notification preferences");
      }
    }
    console.log(
      JSON.stringify({
        pending: changes.length,
        registered: registered.size,
        unregistered: input.identifiers.filter(
          (identifier) => !registered.has(identifier),
        ),
        changes,
      }),
    );
  });
}
