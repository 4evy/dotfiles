{
  pkgs,
  inputs,
  environment ? { },
}:
let
  inherit (pkgs)
    lib
    runCommandLocal
    stdenv
    writeText
    writeShellApplication
    ;
  configured =
    name: fallback:
    let
      value = environment.${name} or "";
    in
    if value != "" then value else fallback;
  os = configured "HJEM_PLATFORM" (if stdenv.hostPlatform.isDarwin then "darwin" else "linux");
  home = configured "HOME" (if os == "darwin" then "/Users/evy" else "/var/home/evy");
  repository = configured "HJEM_WORKING_TREE" (
    if os == "darwin" then "/Users/evy/Developer/dotfiles" else "/var/home/evy/dotfiles"
  );
  brewPrefix = configured "HOMEBREW_PREFIX" (
    if os == "darwin" then "/opt/homebrew" else "/home/linuxbrew/.linuxbrew"
  );
  metadata = lib.importJSON ../../manifest.json;
  enabled = entry: !(entry ? systems) || lib.elem os entry.systems;
  commandAvailable =
    name:
    lib.any (directory: lib.pathExists "${directory}/${name}") (
      lib.splitString ":" (environment.PATH or "")
    );
  substitute =
    lib.replaceStrings
      [ "@HOME@" "@REPOSITORY@" "@OS@" "@HOMEBREW_PREFIX@" ]
      [ home repository os brewPrefix ];
  sourceText = entry: substitute (lib.readFile (../../files + "/${entry.source}"));
  fileEntry =
    entry:
    {
      inherit (entry) target;
      executable = entry.executable or false;
      type = if (entry.private or false) || (entry.mutable or false) then "copy" else "symlink";
    }
    // (
      if entry.symlink or false then
        {
          source =
            let
              destination = lib.strings.trim (sourceText entry);
            in
            if lib.hasPrefix "/" destination then
              destination
            else
              "${dirOf "${home}/${entry.target}"}/${destination}";
        }
      else if lib.pathIsDirectory (../../files + "/${entry.source}") then
        # Keep module siblings together when runtimes resolve symlink targets
        { source = ../../files + "/${entry.source}"; }
      else
        { text = sourceText entry; }
    )
    // lib.optionalAttrs ((entry.private or false) || (entry.mutable or false)) {
      permissions =
        if entry.private or false then
          if entry.executable or false then "0700" else "0600"
        else if entry.executable or false then
          "0755"
        else
          "0644";
    };
  static = lib.filter (
    entry:
    enabled entry
    && !(entry.nixGenerated or false)
    # Target-host PATH probes intentionally make impure evaluation depend on
    # installed host tools rather than the source revision alone
    && (!(entry ? requireCommand) || commandAvailable entry.requireCommand)
  ) metadata.files;
  applicationFiles = import ./files.nix {
    inherit
      pkgs
      home
      repository
      os
      environment
      ;
  };
  # Resolve optional home-installed tools at activation time, not evaluation time
  optionalHomeCommand =
    {
      name,
      preferHome ? true,
    }:
    ''
      ${lib.toShellVar "command" name}
      if [ -x "$HJEM_HOME_DIR/.local/bin/$command" ]; then
        ${if preferHome then ''"$HJEM_HOME_DIR/.local/bin/$command"'' else ''"$command"''}
      elif command -v "$command" >/dev/null 2>&1; then
        "$command"
      else
        printf "%s\n" "$command skipped: command not found"
      fi
    '';
  # Inline bodies use stable manifest hook names, not source file paths
  shellHooks = {
    "bat_catppuccin_custom.sh".text = ''
      if command -v bat >/dev/null 2>&1; then
        bat cache --build >/dev/null
      elif command -v batcat >/dev/null 2>&1; then
        batcat cache --build >/dev/null
      fi
    '';
    "discord_equicord.sh".text = optionalHomeCommand { name = "sync-equicord-settings"; };
    "ghostty_dreamy_swirl.sh" = {
      bashOptions = [
        "errexit"
        "nounset"
        "pipefail"
      ];
      text = ''
        generator="''${HJEM_HOME_DIR}/.local/lib/ghostty/ghostty.ts"
        if [[ -x "$generator" ]]; then
          "$generator"
        fi
      '';
    };
    "gnome_catppuccin_custom_accent.sh".text = lib.concatLines [
      (optionalHomeCommand { name = "gnome-catppuccin-custom-accent"; })
      ''
        if command -v systemctl >/dev/null 2>&1 &&
          systemctl --user show-environment >/dev/null 2>&1; then
          systemctl --user daemon-reload
          systemctl --user enable gnome-catppuccin-custom-accent.service
          # Pick up the rebuilt workstation executable even if already running
          systemctl --user restart gnome-catppuccin-custom-accent.service
        fi
      ''
    ];
    "lsp_dependencies.sh" = {
      runtimeInputs = [ pkgs.coreutils ];
      text = ''
        # Install beside the LSP library so editor launchers resolve dependencies
        if ! command -v bun >/dev/null 2>&1; then
          printf '%s\n' 'LSP dependency install requires Bun on PATH' >&2
          exit 1
        fi
        bun install --cwd "$HJEM_HOME_DIR/.local/lib/typescript" --frozen-lockfile --production --ignore-scripts
        # The editor frontend uses our Rust SDK, not its bundled Go fallback
        for extension in "$HJEM_HOME_DIR"/.vscode/extensions/typescriptteam.native-preview-*; do
          [ -d "$extension" ] || continue
          rm -f "$extension/lib/tsc"
        done
      '';
    };
    "macos_catppuccin_custom_appearance.sh".text = optionalHomeCommand {
      name = "macos-catppuccin-custom-appearance";
      # These macOS hooks historically invoke PATH even when the home tool exists
      preferHome = false;
    };
    "nix_github_auth.sh" = {
      runtimeInputs = [ pkgs.coreutils ];
      text = ''
        if ! command -v nix >/dev/null 2>&1 || ! command -v gh >/dev/null 2>&1; then
          exit 0
        fi
        if ! token=$(gh auth token --hostname github.com 2>/dev/null); then
          exit 0
        fi

        # Keep credentials outside the source tree and Nix store
        umask 077
        config_dir="$HJEM_HOME_DIR/.config/nix"
        mkdir -p "$config_dir"
        temporary=$(mktemp "$config_dir/.github-access-tokens.XXXXXXXXXX")
        trap 'rm -f "$temporary"' EXIT
        # Preserve cancellation instead of returning success after cleanup
        trap 'exit 129' HUP
        trap 'exit 130' INT
        trap 'exit 143' TERM
        printf 'access-tokens = github.com=%s\n' "$token" >"$temporary"
        mv -f "$temporary" "$config_dir/github-access-tokens.conf"
      '';
    };
    "raycast.sh" = {
      runtimeInputs = [ pkgs.coreutils ];
      text = ''
        ${lib.toShellVars {
          source = "/Applications/Nix Apps/Raycast.app";
          manager = "/run/current-system/sw/bin/raycast-manager";
          target = "/Applications/Raycast.app";
          brew = "${brewPrefix}/bin/brew";
        }}
        config="$HOME/.config/raycast/config.json"

        fail() {
          printf 'raycast: %s\n' "$*" >&2
          exit 1
        }

        [ -d "$source" ] || fail "missing Nix app $source, run just darwin"
        [ -x "$manager" ] || fail "missing Nix manager $manager, run just darwin"
        [ -f "$config" ] || fail "missing configuration $config"

        if [ -L "$target" ]; then
          [ "$(readlink "$target")" = "$source" ] || fail "$target points elsewhere"
        elif [ -e "$target" ]; then
          if [ ! -x "$brew" ] || ! "$brew" list --cask raycast >/dev/null 2>&1; then
            fail "$target is not the Homebrew installation"
          fi
          "$brew" uninstall --cask raycast
          if [ -e "$target" ] || [ -L "$target" ]; then
            fail "Homebrew left $target in place"
          fi
          ln -s "$source" "$target"
        else
          ln -s "$source" "$target"
        fi

        exec "$manager" configure "$config"
      '';
    };
    "rustdesk.sh" = {
      runtimeInputs = [ pkgs.coreutils ];
      text = ''
        bun "$HJEM_WORKING_TREE/tools/setup/applications.ts" rustdesk
        if [ "$(uname -s)" = Darwin ]; then
          domain="gui/$(id -u)"
          if ! /bin/launchctl print "$domain/com.carriez.RustDesk" >/dev/null 2>&1; then
            /bin/launchctl bootstrap "$domain" "$HJEM_HOME_DIR/Library/LaunchAgents/com.carriez.RustDesk.plist"
          fi
        fi
      '';
    };
    "super_engineering_settings.sh" = {
      runtimeInputs = lib.attrValues {
        inherit (pkgs) coreutils diffutils jq;
      };
      text = ''

        home=''${HJEM_HOME_DIR:-$HOME}
        settings="$home/.super.engineering/settings.json"
        config="$home/.config/super-engineering/settings.json"

        # Native settings also contain mutable project and workspace state
        # Merge managed JSON preferences instead of replacing the app-owned file
        # Apply with the app closed to avoid its stale in-memory saves
        [ -f "$settings" ] || exit 0

        temporary=$(mktemp -d "$settings.dotfiles.XXXXXX")
        trap 'rm -rf "$temporary"' EXIT
        # Stop on cancellation rather than resuming after removing the workspace
        trap 'exit 129' HUP
        trap 'exit 130' INT
        trap 'exit 143' TERM
        cp -p "$settings" "$temporary/original"
        # Redirection truncates contents but keeps the mode for the final rename
        cp -p "$settings" "$temporary/updated"
        # App actions and provider slash commands use the same prompt sources
        # The manifest also installs them under .omp/agent/commands for discovery
        jq -n --slurpfile preferences "$config" \
          --rawfile commit "$home/.config/super-engineering/commands/commit.md" \
          --rawfile rebase "$home/.config/super-engineering/commands/rebase.md" '
          $preferences[0] * {
            ai_tier: {
              custom_commands: [
                {
                  id: "299605c4-2761-4df7-b898-f60369434ff1",
                  name: "Commit by domain",
                  command: ($commit | rtrimstr("\n")),
                  auto_submit: true,
                  dispatch_mode: "inject_current_chat",
                  view_preference: "default"
                },
                {
                  id: "f3ca99ff-ea59-41c5-97f6-ceabc6a08d47",
                  name: "Rebase onto upstream",
                  command: ($rebase | rtrimstr("\n")),
                  auto_submit: true,
                  dispatch_mode: "inject_current_chat",
                  view_preference: "default"
                },
                # Keep Session default unchanged and wait for a user prompt
                {
                  id: "1f59deeb-37f9-43e0-be66-360e6e154a2a",
                  name: "Quick chat",
                  command: "Handle the next request in this fresh chat.",
                  auto_submit: false,
                  dispatch_mode: "new_tab",
                  view_preference: "chat",
                  provider_preset_key: "omp",
                  model_id: "openai-codex/gpt-6-luna"
                }
              ]
            }
          }
        ' >"$temporary/managed"
        # Stable IDs replace only these commands, preserving personal additions
        jq -s '
          reduce .[1].ai_tier.custom_commands[] as $command
            (.[0] * (.[1] | del(.ai_tier.custom_commands));
             .ai_tier.custom_commands =
               ((.ai_tier.custom_commands // [] |
                 map(select(.id != $command.id))) + [$command]))
        ' "$temporary/original" "$temporary/managed" >"$temporary/updated"

        # Preserve app-serialized floats and unrelated settings
        # when managed preferences already match
        if jq -e -s '.[0] == .[1]' "$temporary/original" "$temporary/updated" >/dev/null; then
          exit 0
        fi

        # Refuse to overwrite settings saved by the running app during the merge
        if ! cmp -s "$settings" "$temporary/original"; then
          printf '%s\n' 'super.engineering settings changed during apply, run just apply again' >&2
          exit 1
        fi
        mv "$temporary/updated" "$settings"
      '';
    };
    "terminal_app_catppuccin_custom.sh".text = optionalHomeCommand {
      name = "terminal-catppuccin-custom";
      preferHome = false;
    };
    "vscode_catppuccin_custom_icons.sh".text = optionalHomeCommand {
      name = "vscode-catppuccin-custom-icons";
    };
    "yazi_init.sh".text = ''
      if ! command -v ya >/dev/null 2>&1; then
        printf '%s\n' 'Yazi plugin install skipped: ya not found'
        exit 0
      fi
      export YAZI_CONFIG_HOME="''${XDG_CONFIG_HOME:-$HJEM_HOME_DIR/.config}/yazi"
      if [ ! -f "$YAZI_CONFIG_HOME/package.toml" ]; then
        printf 'Yazi plugin install skipped: %s/package.toml not found\n' "$YAZI_CONFIG_HOME"
        exit 0
      fi
      exec ya pkg install --discard
    '';
  };
  # Include every platform so disabled hooks are not mistaken for dead code
  shellHookNames = map (entry: entry.name) (lib.filter (entry: !(entry ? command)) metadata.hooks);
  missingShellHooks = lib.subtractLists (lib.attrNames shellHooks) shellHookNames;
  unusedShellHooks = lib.subtractLists shellHookNames (lib.attrNames shellHooks);
  # The runner in home/deploy/apply.ts executes these after Hjem switches
  hooks = map (
    entry:
    let
      inherit (entry) name;
      command =
        if entry ? command then
          map substitute entry.command
        else
          [
            (lib.getExe (
              writeShellApplication (
                {
                  name = "hjem-hook-${name}";
                  # Optional apps and host/session tools still come from PATH
                  inheritPath = true;
                  # Most hooks use -eu, only Ghostty opts into pipefail
                  bashOptions = [
                    "errexit"
                    "nounset"
                  ];
                }
                // shellHooks.${name}
              )
            ))
          ];
    in
    {
      inherit name command;
      onchange = entry.onChange or false;
      inputs = map substitute (entry.inputs or [ ]);
    }
  ) (lib.filter enabled metadata.hooks);
  generators = lib.importJSON ../../generators.json;
  manifest = writeText "hjem-manifest.json" (
    lib.toJSON (
      import ./manifest.nix {
        inherit pkgs inputs home;
        files =
          map fileEntry static
          ++ applicationFiles
          ++ import ./externals.nix {
            inherit inputs lib os;
          };
      }
    )
  );
  hookMetadata = writeText "hjem-hooks.json" (lib.toJSON hooks);
  generatorMetadata = writeText "hjem-generators.json" (lib.toJSON generators);
in
assert lib.assertMsg (
  home != "" && lib.hasPrefix "/" home
) "Hjem requires an absolute home directory";
assert lib.assertMsg (
  repository != "" && lib.hasPrefix "/" repository
) "Hjem requires an absolute checkout path";
assert lib.assertMsg (
  missingShellHooks == [ ]
) "Hjem hooks have no command or shellHooks entry: ${lib.concatStringsSep ", " missingShellHooks}";
assert lib.assertMsg (unusedShellHooks == [ ])
  "Hjem shellHooks entries have no matching commandless manifest hook: ${lib.concatStringsSep ", " unusedShellHooks}";
runCommandLocal "hjem-home" { } ''
  mkdir -p "$out"
  cp ${manifest} "$out/manifest.json"
  cp ${hookMetadata} "$out/hooks.json"
  cp ${generatorMetadata} "$out/generators.json"
''
