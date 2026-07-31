const std = @import("std");
const config = @import("config.zig");
const constants = @import("constants.zig");
const theme = @import("theme.zig");
const c = @import("c");

fn helperTimeout(milliseconds: u32) std.Io.Timeout {
    return .{ .duration = .{ .raw = .fromMilliseconds(milliseconds), .clock = .awake } };
}

pub const Prepared = struct {
    argv: std.ArrayList([]const u8) = .empty,
    temporary_path: ?[:0]u8 = null,

    pub fn deinit(self: *Prepared, allocator: std.mem.Allocator) void {
        self.argv.deinit(allocator);
        if (self.temporary_path) |path| {
            _ = c.unlink(path.ptr);
            allocator.free(path);
        }
    }
};

fn isPathLike(value: []const u8) bool {
    return std.fs.path.isAbsolute(value) or std.mem.indexOfScalar(u8, value, '/') != null;
}

fn expandPath(allocator: std.mem.Allocator, env: *const std.process.Environ.Map, value: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, value, "~/")) {
        if (env.get(constants.environment.home)) |home| return std.fs.path.join(allocator, &.{ home, value[2..] });
    }
    return allocator.dupe(u8, value);
}

fn executable(io: std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(io, path, .{ .execute = true }) catch return false;
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .file;
}

fn sameFile(allocator: std.mem.Allocator, io: std.Io, left: []const u8, right: []const u8) bool {
    const left_real = std.Io.Dir.cwd().realPathFileAlloc(io, left, allocator) catch return false;
    defer allocator.free(left_real);
    const right_real = std.Io.Dir.cwd().realPathFileAlloc(io, right, allocator) catch return false;
    defer allocator.free(right_real);
    return std.mem.eql(u8, left_real, right_real);
}

fn skipped(allocator: std.mem.Allocator, io: std.Io, candidate_path: []const u8, skip_paths: []const []const u8) bool {
    for (skip_paths) |path| if (sameFile(allocator, io, candidate_path, path)) return true;
    return false;
}

fn candidate(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, raw: []const u8, skip_paths: []const []const u8) !?[]const u8 {
    var name = raw;
    if (std.mem.startsWith(u8, raw, "$")) {
        if (raw.len == 1) return null;
        name = env.get(raw[1..]) orelse return null;
        if (name.len == 0) return null;
    }
    const expanded = try expandPath(allocator, env, name);
    if (isPathLike(expanded)) {
        if (executable(io, expanded) and !skipped(allocator, io, expanded, skip_paths)) return expanded;
        return null;
    }
    const path = env.get(constants.environment.path) orelse constants.filesystem.default_search_path;
    var directories = std.mem.splitScalar(u8, path, std.fs.path.delimiter);
    while (directories.next()) |directory| {
        const joined = if (directory.len == 0) try allocator.dupe(u8, expanded) else try std.fs.path.join(allocator, &.{ directory, expanded });
        if (executable(io, joined) and !skipped(allocator, io, joined, skip_paths)) return joined;
    }
    return null;
}

pub fn resolve(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, runner: *const config.Runner, requested: []const u8) ![]const u8 {
    if (isPathLike(requested)) return allocator.dupe(u8, requested);
    var skip_paths: std.ArrayList([]const u8) = .empty;
    defer skip_paths.deinit(allocator);
    for (runner.skip_env) |name| if (env.get(name)) |paths| {
        var it = std.mem.splitScalar(u8, paths, std.fs.path.delimiter);
        while (it.next()) |path| if (path.len != 0) try skip_paths.append(allocator, path);
    };
    if (std.process.executablePathAlloc(io, allocator)) |self| try skip_paths.append(allocator, self) else |_| {}

    if (try candidate(allocator, io, env, requested, skip_paths.items)) |path| return path;
    const programs = if (runner.programs.len == 0) &.{runner.name} else runner.programs;
    for (programs) |program| {
        if (std.mem.eql(u8, program, requested)) continue;
        if (try candidate(allocator, io, env, program, skip_paths.items)) |path| return path;
    }
    return error.FileNotFound;
}

fn replaceAll(allocator: std.mem.Allocator, input: []const u8, needle: []const u8, replacement: []const u8) ![]const u8 {
    var output: std.ArrayList(u8) = .empty;
    var rest = input;
    while (std.mem.indexOf(u8, rest, needle)) |index| {
        try output.appendSlice(allocator, rest[0..index]);
        try output.appendSlice(allocator, replacement);
        rest = rest[index + needle.len ..];
    }
    try output.appendSlice(allocator, rest);
    return output.toOwnedSlice(allocator);
}

fn render(allocator: std.mem.Allocator, template: []const u8, theme_name: []const u8, context: []const u8) ![]const u8 {
    const themed = try replaceAll(allocator, template, constants.template.theme, theme_name);
    return replaceAll(allocator, themed, constants.template.context, context);
}

fn argumentValue(arguments: []const []const u8, flags: []const []const u8, prefixes: []const []const u8, separator: ?[]const u8) ?[]const u8 {
    var result: ?[]const u8 = null;
    var index: usize = 0;
    while (index < arguments.len) : (index += 1) {
        const arg = arguments[index];
        if (separator) |sep| if (std.mem.eql(u8, arg, sep)) break;
        for (flags) |flag| if (std.mem.eql(u8, arg, flag) and index + 1 < arguments.len) {
            index += 1;
            result = arguments[index];
        };
        for (prefixes) |prefix| {
            if (std.mem.startsWith(u8, arg, prefix) and arg.len > prefix.len) result = arg[prefix.len..];
        }
    }
    return result;
}

fn canonicalDirectory(allocator: std.mem.Allocator, io: std.Io, cwd: []const u8, value: []const u8) ![]const u8 {
    const path = if (std.fs.path.isAbsolute(value)) value else try std.fs.path.join(allocator, &.{ cwd, value });
    return std.Io.Dir.cwd().realPathFileAlloc(io, path, allocator) catch std.fs.path.resolve(allocator, &.{path});
}

fn quoteToml(allocator: std.mem.Allocator, value: []const u8) ![]const u8 {
    var output: std.ArrayList(u8) = .empty;
    try output.append(allocator, '"');
    for (value) |byte| switch (byte) {
        '\x08' => try output.appendSlice(allocator, "\\b"),
        '\t' => try output.appendSlice(allocator, "\\t"),
        '\n' => try output.appendSlice(allocator, "\\n"),
        '\r' => try output.appendSlice(allocator, "\\r"),
        '"' => try output.appendSlice(allocator, "\\\""),
        '\\' => try output.appendSlice(allocator, "\\\\"),
        else => if (byte < 0x20 or byte == 0x7f) {
            try output.appendSlice(allocator, &.{ '\\', 'u', '0', '0', constants.text.hex_digits[byte >> 4], constants.text.hex_digits[byte & 0xf] });
        } else try output.append(allocator, byte),
    };
    try output.append(allocator, '"');
    return output.toOwnedSlice(allocator);
}

fn directoryContext(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, runtime: *const config.Runtime, integration: *const config.Integration, arguments: []const []const u8) ![]const u8 {
    const cwd = try std.process.currentPathAlloc(io, allocator);
    const directory = try canonicalDirectory(allocator, io, cwd, argumentValue(arguments, integration.context_path_flags, integration.context_path_prefixes, integration.context_argument_separator) orelse cwd);
    var directories: std.ArrayList([]const u8) = .empty;
    try directories.append(allocator, directory);
    for (integration.context_directory_commands) |command| {
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(allocator);
        for (command) |arg| try argv.append(allocator, try replaceAll(allocator, arg, constants.template.directory, directory));
        const result = std.process.run(allocator, io, .{
            .argv = argv.items,
            .environ_map = env,
            .stdout_limit = .limited(runtime.helper_output_limit_bytes),
            .stderr_limit = .limited(runtime.helper_output_limit_bytes),
            .timeout = helperTimeout(runtime.helper_timeout_ms),
        }) catch continue;
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        if (result.term != .exited or result.term.exited != 0) continue;
        const output = std.mem.trim(u8, result.stdout, constants.text.whitespace);
        if (output.len == 0 or std.mem.indexOfScalar(u8, output, '\n') != null) continue;
        const related = canonicalDirectory(allocator, io, directory, output) catch continue;
        const related_stat = std.Io.Dir.cwd().statFile(io, related, .{}) catch continue;
        if (related_stat.kind != .directory) continue;
        var duplicate = false;
        for (directories.items) |known| {
            if (std.mem.eql(u8, related, known)) duplicate = true;
        }
        if (!duplicate) try directories.append(allocator, related);
    }

    var output: std.ArrayList(u8) = .empty;
    try output.appendSlice(allocator, integration.context_table.?);
    try output.appendSlice(allocator, constants.text.table_open);
    for (directories.items, 0..) |path, index| {
        if (index != 0) try output.append(allocator, ',');
        try output.appendSlice(allocator, try quoteToml(allocator, path));
        try output.appendSlice(allocator, constants.text.table_open);
        try output.appendSlice(allocator, integration.context_field.?);
        try output.append(allocator, '=');
        try output.appendSlice(allocator, try quoteToml(allocator, integration.context_value.?));
        try output.append(allocator, '}');
    }
    try output.append(allocator, '}');
    return output.toOwnedSlice(allocator);
}

fn configFlag(integration: *const config.Integration, arg: []const u8) bool {
    for (integration.config_flags) |flag| if (std.mem.eql(u8, flag, arg)) return true;
    return false;
}

fn configPath(allocator: std.mem.Allocator, env: *const std.process.Environ.Map, integration: *const config.Integration, arguments: []const []const u8) ![]const u8 {
    var index: usize = 0;
    while (index < arguments.len) : (index += 1) {
        if (configFlag(integration, arguments[index]) and index + 1 < arguments.len) return expandPath(allocator, env, arguments[index + 1]);
        for (integration.config_flags) |flag| if (std.mem.startsWith(u8, arguments[index], flag) and arguments[index].len > flag.len and arguments[index][flag.len] == '=') return expandPath(allocator, env, arguments[index][flag.len + 1 ..]);
    }
    const home = env.get(constants.environment.home) orelse return allocator.dupe(u8, "");
    return std.fs.path.join(allocator, &.{ home, integration.default_config.? });
}

const AssignmentPatch = struct {
    line: ?usize = null,
    table: bool = false,
    prepend_if_missing: bool = false,
};

fn tableHeaderBelongsToKey(line: []const u8, key: []const u8) bool {
    var rest = std.mem.trimStart(u8, line, " \t");
    if (rest.len < 2 or rest[0] != '[' or rest[1] == '[') return false;
    rest = std.mem.trimStart(u8, rest[1..], " \t");
    if (!std.mem.startsWith(u8, rest, key)) return false;
    rest = std.mem.trimStart(u8, rest[key.len..], " \t");
    return rest.len != 0 and (rest[0] == ']' or rest[0] == '.');
}

fn patchAssignment(allocator: std.mem.Allocator, contents: []const u8, key: []const u8, quote: u8, value: []const u8, policy: AssignmentPatch) ![]const u8 {
    var output: std.ArrayList(u8) = .empty;
    var lines = std.mem.splitScalar(u8, contents, '\n');
    var replaced = false;
    var skipping_table = false;
    var line_number: usize = 1;
    while (lines.next()) |line| {
        defer line_number += 1;
        if (skipping_table) {
            const trimmed = std.mem.trimStart(u8, line, " \t");
            if (trimmed.len == 0 or trimmed[0] != '[') continue;
            if (tableHeaderBelongsToKey(line, key)) continue;
            skipping_table = false;
        }
        const trimmed = std.mem.trimStart(u8, line, constants.text.horizontal_whitespace);
        var matches = false;
        if (policy.line) |expected| {
            matches = line_number == expected;
        } else if (std.mem.startsWith(u8, trimmed, key)) {
            const rest = std.mem.trimStart(u8, trimmed[key.len..], constants.text.horizontal_whitespace);
            matches = rest.len != 0 and rest[0] == '=';
        }
        if (!replaced and matches) {
            try output.appendSlice(allocator, key);
            try output.appendSlice(allocator, constants.text.assignment);
            try output.append(allocator, quote);
            try output.appendSlice(allocator, value);
            try output.append(allocator, quote);
            replaced = true;
            skipping_table = policy.table and tableHeaderBelongsToKey(line, key);
        } else try output.appendSlice(allocator, line);
        if (lines.index != null) try output.append(allocator, '\n');
    }
    if (!replaced) {
        if (policy.prepend_if_missing) {
            var prefixed: std.ArrayList(u8) = .empty;
            try prefixed.appendSlice(allocator, key);
            try prefixed.appendSlice(allocator, constants.text.assignment);
            try prefixed.append(allocator, quote);
            try prefixed.appendSlice(allocator, value);
            try prefixed.appendSlice(allocator, &.{ quote, '\n' });
            try prefixed.appendSlice(allocator, output.items);
            output.deinit(allocator);
            return prefixed.toOwnedSlice(allocator);
        }
        if (output.items.len != 0 and output.items[output.items.len - 1] != '\n') try output.append(allocator, '\n');
        try output.appendSlice(allocator, key);
        try output.appendSlice(allocator, constants.text.assignment);
        try output.append(allocator, quote);
        try output.appendSlice(allocator, value);
        try output.appendSlice(allocator, &.{ quote, '\n' });
    }
    return output.toOwnedSlice(allocator);
}

fn makeTemporary(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, integration: *const config.Integration, contents: []const u8) ![:0]u8 {
    const directory = switch (integration.temporary_location.?) {
        .system => env.get(constants.environment.temporary_directory) orelse constants.filesystem.default_temporary_directory,
        .cache => cache: {
            const base = env.get(constants.environment.xdg_cache_home) orelse if (env.get(constants.environment.home)) |home| try std.fs.path.join(allocator, &.{ home, constants.filesystem.default_cache_directory }) else constants.filesystem.default_temporary_directory;
            break :cache try std.fs.path.join(allocator, &.{ base, integration.cache_subdirectory.? });
        },
    };
    try std.Io.Dir.cwd().createDirPath(io, directory);
    const template = try std.fs.path.join(allocator, &.{ directory, integration.temporary_prefix.? });
    const path = try allocator.dupeZ(u8, template);
    errdefer allocator.free(path);
    const fd = c.mkstemp(path.ptr);
    if (fd < 0) return error.TemporaryFileFailed;
    errdefer _ = c.unlink(path.ptr);
    defer _ = c.close(fd);
    var written: usize = 0;
    while (written < contents.len) {
        const count = c.write(fd, contents[written..].ptr, contents.len - written);
        if (count <= 0) return error.TemporaryFileFailed;
        written += @intCast(count);
    }
    return path;
}

pub fn prepare(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, runtime: *const config.Runtime, integration: ?*const config.Integration, extra: []const []const u8) !Prepared {
    return prepareForTheme(allocator, io, env, runtime, integration, extra, theme.detect(allocator, io, runtime, env));
}

pub fn prepareForTheme(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, runtime: *const config.Runtime, integration: ?*const config.Integration, extra: []const []const u8, mode: config.Theme) !Prepared {
    var result: Prepared = .{};
    errdefer result.deinit(allocator);
    const selected = integration orelse {
        try result.argv.appendSlice(allocator, extra);
        return result;
    };
    const theme_name = if (mode == .dark) selected.dark_theme else selected.light_theme;
    switch (selected.strategy) {
        .arguments => {
            const context = if (selected.context_table != null) try directoryContext(allocator, io, env, runtime, selected, extra) else "";
            for (selected.arguments) |template| try result.argv.append(allocator, try render(allocator, template, theme_name, context));
            try result.argv.appendSlice(allocator, extra);
        },
        .config => {
            const path = try configPath(allocator, env, selected, extra);
            const contents = std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(config.max_file_bytes)) catch |err| switch (err) {
                error.FileNotFound => try allocator.dupe(u8, ""),
                else => return err,
            };
            var patch_policy: AssignmentPatch = .{};
            if (selected.validation == .toml) {
                const assignment = try allocator.dupeZ(u8, selected.assignment.?);
                const inspected = try config.inspectTomlAssignment(allocator, contents, selected.display_name, assignment);
                patch_policy = .{
                    .line = inspected.line,
                    .table = inspected.kind == .table,
                    .prepend_if_missing = inspected.kind == .missing,
                };
            }
            const patched = try patchAssignment(allocator, contents, selected.assignment.?, selected.quote.?, theme_name, patch_policy);
            if (selected.validation == .toml) try config.validateToml(allocator, patched, selected.display_name);
            result.temporary_path = try makeTemporary(allocator, io, env, selected, patched);
            try result.argv.append(allocator, selected.config_output_flag.?);
            try result.argv.append(allocator, result.temporary_path.?);
            var index: usize = 0;
            while (index < extra.len) : (index += 1) {
                if (configFlag(selected, extra[index])) {
                    if (index + 1 < extra.len) index += 1;
                    continue;
                }
                var joined = false;
                for (selected.config_flags) |flag| {
                    if (std.mem.startsWith(u8, extra[index], flag) and extra[index].len > flag.len and extra[index][flag.len] == '=') joined = true;
                }
                if (!joined) try result.argv.append(allocator, extra[index]);
            }
        },
    }
    return result;
}

fn usesInterpreter(interpreter: *const config.Interpreter, executable_path: []const u8, io: std.Io) bool {
    var buffer: [constants.filesystem.shebang_read_bytes]u8 = undefined;
    const text = std.Io.Dir.cwd().readFile(io, executable_path, &buffer) catch return false;
    const line = text[0 .. std.mem.indexOfScalar(u8, text, '\n') orelse text.len];
    if (!std.mem.startsWith(u8, line, constants.text.shebang)) return false;
    var tokens = std.mem.tokenizeAny(u8, line[constants.text.shebang.len..], constants.text.whitespace);
    const command = tokens.next() orelse return false;
    const argument = tokens.next() orelse return false;
    return contains(interpreter.shebang_commands, command) and contains(interpreter.shebang_arguments, argument);
}

fn findInterpreter(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, interpreter: *const config.Interpreter) ![]const u8 {
    for (interpreter.programs) |program| if (try candidate(allocator, io, env, program, &.{})) |path| return path;
    return error.InterpreterNotFound;
}

pub const Invocation = struct {
    allocator: std.mem.Allocator,
    argv: std.ArrayList([]const u8),
    environment: std.process.Environ.Map,
    prepared: Prepared,

    pub fn deinit(self: *Invocation) void {
        self.environment.deinit();
        self.argv.deinit(self.allocator);
        self.prepared.deinit(self.allocator);
    }

    pub fn execute(self: *Invocation, io: std.Io) !u8 {
        var child = try std.process.spawn(io, .{ .argv = self.argv.items, .environ_map = &self.environment });
        const term = try child.wait(io);
        return switch (term) {
            .exited => |status| status,
            .signal => |signal| constants.exit.signal_offset + @as(u8, @intCast(@intFromEnum(signal))),
            else => constants.exit.cannot_execute,
        };
    }
};

pub fn prepareInvocation(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, manifest: *const config.Manifest, runner: *const config.Runner, requested: []const u8, extra: []const []const u8, forced_theme: ?config.Theme) !Invocation {
    var executable_path = try resolve(allocator, io, env, runner, requested);
    const integration = if (runner.integration) |name| manifest.findIntegration(name) else null;
    var prepared = if (forced_theme) |mode|
        try prepareForTheme(allocator, io, env, &manifest.runtime, integration, extra, mode)
    else
        try prepare(allocator, io, env, &manifest.runtime, integration, extra);
    errdefer prepared.deinit(allocator);
    var argv: std.ArrayList([]const u8) = .empty;
    errdefer argv.deinit(allocator);
    if (runner.interpreter) |name| {
        const interpreter = manifest.findInterpreter(name) orelse return error.MissingInterpreter;
        if (usesInterpreter(interpreter, executable_path, io)) {
            const script = executable_path;
            executable_path = try findInterpreter(allocator, io, env, interpreter);
            try argv.append(allocator, executable_path);
            try argv.append(allocator, script);
        } else try argv.append(allocator, executable_path);
    } else try argv.append(allocator, executable_path);
    try argv.appendSlice(allocator, runner.default_args);
    try argv.appendSlice(allocator, prepared.argv.items);

    var child_env = try env.clone(allocator);
    errdefer child_env.deinit();
    for (runner.env_unset) |name| _ = child_env.swapRemove(name);
    for (runner.env) |pair| try child_env.put(pair.key, pair.value);
    return .{
        .allocator = allocator,
        .argv = argv,
        .environment = child_env,
        .prepared = prepared,
    };
}

pub fn runMatched(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map, manifest: *const config.Manifest, runner: *const config.Runner, requested: []const u8, extra: []const []const u8) !u8 {
    var invocation = try prepareInvocation(allocator, io, env, manifest, runner, requested, extra, null);
    defer invocation.deinit();
    return invocation.execute(io);
}

pub fn execUnknown(allocator: std.mem.Allocator, argv: []const [:0]const u8) u8 {
    const pointers = allocator.alloc(?[*:0]const u8, argv.len + 1) catch return constants.exit.cannot_execute;
    for (argv, 0..) |arg, index| pointers[index] = arg.ptr;
    pointers[argv.len] = null;
    _ = c.execvp(argv[0].ptr, @ptrCast(pointers.ptr));
    return if (std.c.errno(-1) == .NOENT) constants.exit.not_found else constants.exit.cannot_execute;
}

fn contains(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
}

test "patches a configured assignment" {
    const patched = try patchAssignment(std.testing.allocator, "x = 1\nstyle = \"old\"\n", "style", '"', "new", .{});
    defer std.testing.allocator.free(patched);
    try std.testing.expectEqualStrings("x = 1\nstyle = \"new\"\n", patched);
}

test "validated table assignment is replaced at the root" {
    const source =
        \\[appearance]
        \\dark = "night"
        \\fallback = "night"
        \\[appearance.variant]
        \\name = "dim"
        \\[view]
        \\line_numbers = "relative"
    ;
    const patched = try patchAssignment(std.testing.allocator, source, "appearance", '\'', "day", .{ .line = 1, .table = true });
    defer std.testing.allocator.free(patched);
    try std.testing.expectEqualStrings("appearance = 'day'\n[view]\nline_numbers = \"relative\"", patched);
    try config.validateToml(std.testing.allocator, patched, "test");
}

test "missing validated assignment is prepended before tables" {
    const patched = try patchAssignment(std.testing.allocator, "[view]\nline_numbers = true\n", "appearance", '\'', "day", .{ .prepend_if_missing = true });
    defer std.testing.allocator.free(patched);
    try std.testing.expectEqualStrings("appearance = 'day'\n[view]\nline_numbers = true\n", patched);
}

test "explicit paths retain exact spelling" {
    const runner = config.Runner{ .name = "tool" };
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    const path = try resolve(std.testing.allocator, std.testing.io, &env, &runner, "./tool");
    defer std.testing.allocator.free(path);
    try std.testing.expectEqualStrings("./tool", path);
}

test "bare aliases use configured fallback while skipping wrappers" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    try temporary.dir.writeFile(std.testing.io, .{
        .sub_path = "alias",
        .data = "#!/bin/sh\nexit 0\n",
        .flags = .{ .permissions = .executable_file },
    });
    try temporary.dir.writeFile(std.testing.io, .{
        .sub_path = "target",
        .data = "#!/bin/sh\nexit 0\n",
        .flags = .{ .permissions = .executable_file },
    });
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try temporary.dir.realPath(std.testing.io, &buffer);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const wrapper = try std.fs.path.join(allocator, &.{ buffer[0..length], "alias" });
    const expected = try std.fs.path.join(allocator, &.{ buffer[0..length], "target" });
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(constants.environment.path, buffer[0..length]);
    try env.put("TEST_WRAPPER", wrapper);
    const runner: config.Runner = .{
        .name = "target",
        .aliases = &.{"alias"},
        .programs = &.{ "alias", "target" },
        .skip_env = &.{"TEST_WRAPPER"},
    };
    const resolved = try resolve(allocator, std.testing.io, &env, &runner, "alias");
    try std.testing.expectEqualStrings(expected, resolved);
}

test "prepared config cleanup removes its private file" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path_length = try temporary.dir.realPath(std.testing.io, &path_buffer);
    const cache_path = path_buffer[0..path_length];

    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(constants.environment.xdg_cache_home, cache_path);
    try env.put("TEST_THEME", constants.toml.dark);
    const runtime: config.Runtime = .{
        .theme_environment = &.{"TEST_THEME"},
        .theme_dark_aliases = &.{},
        .theme_light_aliases = &.{},
        .theme_macos_commands = &.{},
        .theme_unix_commands = &.{},
        .theme_terminal_program_environment = "TEST_TERMINAL",
        .theme_terminal_queries = &.{.{ .key = constants.protocol.wildcard, .value = constants.protocol.background }},
        .theme_macos_fallback = .dark,
        .theme_unix_fallback = .dark,
        .theme_probe_timeout_ms = 1,
        .helper_timeout_ms = 1,
        .helper_output_limit_bytes = 128,
    };
    const integration: config.Integration = .{
        .name = "tool",
        .strategy = .config,
        .display_name = "tool",
        .dark_theme = "night",
        .light_theme = "day",
        .default_config = ".config/tool/config.toml",
        .assignment = "style",
        .config_flags = &.{ "--config", "-c" },
        .config_output_flag = "--config",
        .temporary_prefix = "tool-XXXXXX",
        .temporary_location = .cache,
        .cache_subdirectory = "tool",
        .quote = '"',
    };
    var prepared = try prepare(allocator, std.testing.io, &env, &runtime, &integration, &.{ "--config", "/does/not/exist" });
    const temporary_path = try allocator.dupe(u8, prepared.temporary_path.?);
    try std.Io.Dir.cwd().access(std.testing.io, temporary_path, .{});
    prepared.deinit(allocator);
    try std.testing.expectError(error.FileNotFound, std.Io.Dir.cwd().access(std.testing.io, temporary_path, .{}));
}
