# Terminal theme tools

`terminal-theme-run` is a small Zig launcher that detects the terminal's light or
dark theme and adapts configured applications. Third-party code is compiled into
the artifacts: Ghostty supplies the streaming VT parser and the vendored tomlc17
amalgamation supplies strict TOML parsing. Zig's `std.Io` and process APIs provide file,
environment, and child-process handling

## Build

Zig 0.16.0 is required. Ghostty is pinned to compatible commit
`4d605bf0d819df901a0332bbb320dc849fdd82e4`

From the repository root (the same entry point used by CI and `just`):

```sh
zig build
zig build test
zig fmt --check build.zig packages/terminal-theme-tools/{build.zig,build_support.zig,src/*.zig}
```

The package directory remains independently buildable for Nix and Homebrew packaging

Release packages use `--release=small`, which also strips the binary

## CLI

```text
terminal-theme-run [--help|--version|--print-theme|--print-theme-no-terminal] [--] COMMAND [ARG...]
```

Launcher options stop at `COMMAND`. A command matching a runner name or alias receives
its configured integration; every other command replaces the launcher unchanged

`--print-theme` performs the same environment, Kitty color-scheme, OSC 11, and desktop
fallback detection used for launched applications and prints `dark` or `light`. Shell
startup can export that result as `TERMINAL_THEME`, allowing every subsequent launcher
invocation to reuse one consumed terminal response instead of issuing another query.
`--print-theme-no-terminal` skips terminal I/O and is intended for prompt startup,
where a delayed terminal reply could otherwise become editable shell input.

Generic runtime defaults are embedded from the typed manifest in
`config/defaults.toml`. Application profiles come from
`$XDG_CONFIG_HOME/terminal-theme-run/config.toml`, or from the path-separated list in
`TERMINAL_THEME_RUN_CONFIG`.

The manifest owns all application-specific behavior. `[[runner]]` declares command
resolution and static environment policy, `[[integration]]` declares theme injection
through arguments, a temporary patched config, or rendered environment variables, and
`[[interpreter]]` declares optional shebang matching and interpreter candidates. The Zig
code contains no application-name branches.

## C API

`zig build` installs `include/terminal_theme_tools.h` and
the static and platform shared forms of `libterminal_theme_tools`. The versioned,
opaque-handle ABI has a C23 public header and supports:

- loading the embedded manifest plus an optional in-memory override;
- supplying or importing an environment without process-global mutation;
- inspecting runners, integrations, interpreters, aliases, programs, and themes;
- parsing terminal reports, classifying text, and running full theme detection;
- preparing a command with an automatic or forced theme, inspecting its final `argv`,
  environment, and temporary config path, then executing it; and
- stable status codes, status messages, last-error details, and explicit destroy calls.

A minimal lifecycle looks like this:

```c
#include <terminal_theme_tools.h>

terminal_theme_tools_context *context = nullptr;
terminal_theme_tools_context_options options = {};
if (terminal_theme_tools_context_create(&options, &context) !=
    TERMINAL_THEME_TOOLS_STATUS_OK) {
    return 1;
}

terminal_theme_tools_command *command = nullptr;
const char *arguments[] = {"--version"};
terminal_theme_tools_status status = terminal_theme_tools_prepare(
    context,
    "configured-tool",
    arguments,
    1,
    TERMINAL_THEME_TOOLS_THEME_UNKNOWN,
    &command);

if (status == TERMINAL_THEME_TOOLS_STATUS_OK) {
    uint8_t exit_code = 0;
    status = terminal_theme_tools_command_execute(command, &exit_code);
    terminal_theme_tools_command_destroy(command);
}
terminal_theme_tools_context_destroy(context);
```

Returned string views are borrowed. Context inputs are copied, commands must be
destroyed before their context, and prepared command views live until command
destruction. See the installed header for the complete API. `zig build test` compiles
and runs a C23 consumer that loads a manifest, inspects it, detects and forces themes,
prepares a child environment, and executes a real process.
