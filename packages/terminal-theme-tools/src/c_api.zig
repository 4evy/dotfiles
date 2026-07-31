const std = @import("std");
const library = @import("terminal_theme_tools");

const abi_version: u32 = 1;
const empty_string: String = .{ .data = null, .length = 0 };
const error_buffer_bytes: usize = 256;

const Status = enum(c_int) {
    ok = 0,
    invalid_argument = 1,
    out_of_memory = 2,
    invalid_manifest = 3,
    not_found = 4,
    io_error = 5,
    execution_error = 6,
    internal_error = 255,
};

const Theme = enum(c_int) {
    unknown = 0,
    dark = 1,
    light = 2,
};

const IntegrationStrategy = enum(c_int) {
    unknown = 0,
    arguments = 1,
    config = 2,
};

const String = extern struct {
    data: ?[*]const u8,
    length: usize,
};

const ContextOptions = extern struct {
    manifest: String,
    environment: ?[*]const ?[*:0]const u8,
    environment_count: usize,
};

const Context = struct {
    arena: std.heap.ArenaAllocator,
    threaded_io: std.Io.Threaded,
    environment: std.process.Environ.Map,
    manifest: library.config.Manifest,
    last_error: [error_buffer_bytes]u8 = undefined,
    last_error_length: usize = 0,

    fn allocator(self: *Context) std.mem.Allocator {
        return self.arena.allocator();
    }

    fn io(self: *Context) std.Io {
        return self.threaded_io.io();
    }

    fn clearError(self: *Context) void {
        self.last_error_length = 0;
    }

    fn setError(self: *Context, err: anyerror) void {
        const name = @errorName(err);
        self.last_error_length = @min(name.len, self.last_error.len);
        @memcpy(self.last_error[0..self.last_error_length], name[0..self.last_error_length]);
    }
};

const Command = struct {
    arena: std.heap.ArenaAllocator,
    invocation: library.launch.Invocation,
    io: std.Io,
};

fn view(bytes: []const u8) String {
    if (bytes.len == 0) return empty_string;
    return .{ .data = bytes.ptr, .length = bytes.len };
}

fn input(value: String) ?[]const u8 {
    if (value.data) |data| return data[0..value.length];
    return if (value.length == 0) &.{} else null;
}

fn statusMessage(status: Status) []const u8 {
    return switch (status) {
        .ok => "success",
        .invalid_argument => "invalid argument",
        .out_of_memory => "out of memory",
        .invalid_manifest => "invalid manifest",
        .not_found => "not found",
        .io_error => "I/O error",
        .execution_error => "execution error",
        .internal_error => "internal error",
    };
}

fn statusForError(err: anyerror) Status {
    return switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.FileNotFound, error.MissingIntegration, error.MissingInterpreter, error.InterpreterNotFound => .not_found,
        error.AccessDenied, error.InputOutput, error.SystemResources, error.Unexpected => .io_error,
        else => .internal_error,
    };
}

fn putEnvironmentEntry(map: *std.process.Environ.Map, entry: []const u8) !void {
    const separator = std.mem.indexOfScalar(u8, entry, '=') orelse return error.InvalidEnvironment;
    if (separator == 0) return error.InvalidEnvironment;
    try map.put(entry[0..separator], entry[separator + 1 ..]);
}

fn loadEnvironment(map: *std.process.Environ.Map, entries: ?[*]const ?[*:0]const u8, count: usize) !void {
    if (entries) |provided| {
        for (provided[0..count]) |entry| try putEnvironmentEntry(map, std.mem.span(entry orelse return error.InvalidEnvironment));
        return;
    }
    if (count != 0) return error.InvalidEnvironment;
    var index: usize = 0;
    while (std.c.environ[index]) |entry| : (index += 1) try putEnvironmentEntry(map, std.mem.span(entry));
}

fn runnerAt(context: ?*const Context, index: usize) ?*const library.config.Runner {
    const ctx = context orelse return null;
    if (index >= ctx.manifest.runners.items.len) return null;
    return &ctx.manifest.runners.items[index];
}

fn integrationAt(context: ?*const Context, index: usize) ?*const library.config.Integration {
    const ctx = context orelse return null;
    if (index >= ctx.manifest.integrations.items.len) return null;
    return &ctx.manifest.integrations.items[index];
}

fn interpreterAt(context: ?*const Context, index: usize) ?*const library.config.Interpreter {
    const ctx = context orelse return null;
    if (index >= ctx.manifest.interpreters.items.len) return null;
    return &ctx.manifest.interpreters.items[index];
}

fn internalTheme(theme_value: Theme) ?library.config.Theme {
    return switch (theme_value) {
        .unknown => null,
        .dark => .dark,
        .light => .light,
    };
}

fn externalTheme(theme_value: ?library.config.Theme) Theme {
    return if (theme_value) |mode| switch (mode) {
        .dark => .dark,
        .light => .light,
    } else .unknown;
}

pub export fn terminal_theme_tools_abi_version() callconv(.c) u32 {
    return abi_version;
}

pub export fn terminal_theme_tools_version() callconv(.c) String {
    return view(library.constants.application.version);
}

pub export fn terminal_theme_tools_status_message(status_code: c_int) callconv(.c) String {
    const status = std.enums.fromInt(Status, status_code) orelse return view(statusMessage(.internal_error));
    return view(statusMessage(status));
}

pub export fn terminal_theme_tools_context_create(options: ?*const ContextOptions, out_context: ?*?*Context) callconv(.c) Status {
    const destination = out_context orelse return .invalid_argument;
    destination.* = null;
    const context = std.heap.c_allocator.create(Context) catch return .out_of_memory;
    context.arena = .init(std.heap.c_allocator);
    context.threaded_io = .init(std.heap.c_allocator, .{});
    const allocator = context.allocator();
    context.environment = std.process.Environ.Map.init(allocator);
    loadEnvironment(&context.environment, if (options) |value| value.environment else null, if (options) |value| value.environment_count else 0) catch |err| {
        context.environment.deinit();
        context.threaded_io.deinit();
        context.arena.deinit();
        std.heap.c_allocator.destroy(context);
        return if (err == error.OutOfMemory) .out_of_memory else .invalid_argument;
    };
    const manifest_text = if (options) |value| input(value.manifest) orelse {
        context.environment.deinit();
        context.threaded_io.deinit();
        context.arena.deinit();
        std.heap.c_allocator.destroy(context);
        return .invalid_argument;
    } else null;
    context.manifest = library.config.Manifest.loadText(allocator, manifest_text) catch |err| {
        context.environment.deinit();
        context.threaded_io.deinit();
        context.arena.deinit();
        std.heap.c_allocator.destroy(context);
        return if (err == error.OutOfMemory) .out_of_memory else .invalid_manifest;
    };
    context.clearError();
    destination.* = context;
    return .ok;
}

pub export fn terminal_theme_tools_context_destroy(context: ?*Context) callconv(.c) void {
    const value = context orelse return;
    value.manifest.deinit();
    value.environment.deinit();
    value.threaded_io.deinit();
    value.arena.deinit();
    std.heap.c_allocator.destroy(value);
}

pub export fn terminal_theme_tools_context_last_error(context: ?*const Context) callconv(.c) String {
    const value = context orelse return empty_string;
    return view(value.last_error[0..value.last_error_length]);
}

pub export fn terminal_theme_tools_runner_count(context: ?*const Context) callconv(.c) usize {
    return if (context) |value| value.manifest.runners.items.len else 0;
}

pub export fn terminal_theme_tools_runner_find(context: ?*Context, name: ?[*:0]const u8, out_index: ?*usize) callconv(.c) Status {
    const ctx = context orelse return .invalid_argument;
    const destination = out_index orelse return .invalid_argument;
    const needle = std.mem.span(name orelse return .invalid_argument);
    ctx.clearError();
    const runner = ctx.manifest.findRunner(needle) orelse {
        ctx.setError(error.RunnerNotFound);
        return .not_found;
    };
    destination.* = (@intFromPtr(runner) - @intFromPtr(ctx.manifest.runners.items.ptr)) / @sizeOf(library.config.Runner);
    return .ok;
}

pub export fn terminal_theme_tools_runner_name(context: ?*const Context, runner_index: usize) callconv(.c) String {
    return view((runnerAt(context, runner_index) orelse return empty_string).name);
}

pub export fn terminal_theme_tools_runner_alias_count(context: ?*const Context, runner_index: usize) callconv(.c) usize {
    return (runnerAt(context, runner_index) orelse return 0).aliases.len;
}

pub export fn terminal_theme_tools_runner_alias(context: ?*const Context, runner_index: usize, alias_index: usize) callconv(.c) String {
    const aliases = (runnerAt(context, runner_index) orelse return empty_string).aliases;
    if (alias_index >= aliases.len) return empty_string;
    return view(aliases[alias_index]);
}

pub export fn terminal_theme_tools_runner_program_count(context: ?*const Context, runner_index: usize) callconv(.c) usize {
    return (runnerAt(context, runner_index) orelse return 0).programs.len;
}

pub export fn terminal_theme_tools_runner_program(context: ?*const Context, runner_index: usize, program_index: usize) callconv(.c) String {
    const programs = (runnerAt(context, runner_index) orelse return empty_string).programs;
    if (program_index >= programs.len) return empty_string;
    return view(programs[program_index]);
}

pub export fn terminal_theme_tools_runner_integration(context: ?*const Context, runner_index: usize) callconv(.c) String {
    return view((runnerAt(context, runner_index) orelse return empty_string).integration orelse return empty_string);
}

pub export fn terminal_theme_tools_runner_interpreter(context: ?*const Context, runner_index: usize) callconv(.c) String {
    return view((runnerAt(context, runner_index) orelse return empty_string).interpreter orelse return empty_string);
}

pub export fn terminal_theme_tools_integration_count(context: ?*const Context) callconv(.c) usize {
    return if (context) |value| value.manifest.integrations.items.len else 0;
}

pub export fn terminal_theme_tools_integration_name(context: ?*const Context, integration_index: usize) callconv(.c) String {
    return view((integrationAt(context, integration_index) orelse return empty_string).name);
}

pub export fn terminal_theme_tools_integration_strategy_at(context: ?*const Context, integration_index: usize) callconv(.c) IntegrationStrategy {
    const integration = integrationAt(context, integration_index) orelse return .unknown;
    return switch (integration.strategy) {
        .arguments => .arguments,
        .config => .config,
    };
}

pub export fn terminal_theme_tools_integration_theme(context: ?*const Context, integration_index: usize, theme_code: c_int) callconv(.c) String {
    const integration = integrationAt(context, integration_index) orelse return empty_string;
    const theme_value = std.enums.fromInt(Theme, theme_code) orelse return empty_string;
    return view(switch (theme_value) {
        .dark => integration.dark_theme,
        .light => integration.light_theme,
        .unknown => return empty_string,
    });
}

pub export fn terminal_theme_tools_interpreter_count(context: ?*const Context) callconv(.c) usize {
    return if (context) |value| value.manifest.interpreters.items.len else 0;
}

pub export fn terminal_theme_tools_interpreter_name(context: ?*const Context, interpreter_index: usize) callconv(.c) String {
    return view((interpreterAt(context, interpreter_index) orelse return empty_string).name);
}

pub export fn terminal_theme_tools_interpreter_program_count(context: ?*const Context, interpreter_index: usize) callconv(.c) usize {
    return (interpreterAt(context, interpreter_index) orelse return 0).programs.len;
}

pub export fn terminal_theme_tools_interpreter_program(context: ?*const Context, interpreter_index: usize, program_index: usize) callconv(.c) String {
    const programs = (interpreterAt(context, interpreter_index) orelse return empty_string).programs;
    if (program_index >= programs.len) return empty_string;
    return view(programs[program_index]);
}

pub export fn terminal_theme_tools_parse_terminal_report(bytes: ?[*]const u8, length: usize) callconv(.c) Theme {
    if (bytes == null and length != 0) return .unknown;
    const data = if (bytes) |pointer| pointer[0..length] else &.{};
    return externalTheme(library.theme.parseReport(std.heap.c_allocator, data));
}

pub export fn terminal_theme_tools_theme_from_text(context: ?*const Context, bytes: ?[*]const u8, length: usize) callconv(.c) Theme {
    const ctx = context orelse return .unknown;
    if (bytes == null and length != 0) return .unknown;
    const data = if (bytes) |pointer| pointer[0..length] else &.{};
    return externalTheme(library.theme.modeFromText(&ctx.manifest.runtime, data));
}

pub export fn terminal_theme_tools_detect_theme(context: ?*Context) callconv(.c) Theme {
    const ctx = context orelse return .unknown;
    ctx.clearError();
    return externalTheme(library.theme.detect(ctx.allocator(), ctx.io(), &ctx.manifest.runtime, &ctx.environment));
}

pub export fn terminal_theme_tools_prepare(context: ?*Context, command_name: ?[*:0]const u8, arguments: ?[*]const ?[*:0]const u8, argument_count: usize, theme_code: c_int, out_command: ?*?*Command) callconv(.c) Status {
    const ctx = context orelse return .invalid_argument;
    const destination = out_command orelse return .invalid_argument;
    destination.* = null;
    const requested = std.mem.span(command_name orelse return .invalid_argument);
    const theme_value = std.enums.fromInt(Theme, theme_code) orelse return .invalid_argument;
    if (requested.len == 0 or (arguments == null and argument_count != 0)) return .invalid_argument;
    const command = std.heap.c_allocator.create(Command) catch return .out_of_memory;
    command.arena = .init(std.heap.c_allocator);
    const allocator = command.arena.allocator();
    const requested_copy = allocator.dupe(u8, requested) catch {
        command.arena.deinit();
        std.heap.c_allocator.destroy(command);
        return .out_of_memory;
    };
    const extra = allocator.alloc([]const u8, argument_count) catch {
        command.arena.deinit();
        std.heap.c_allocator.destroy(command);
        return .out_of_memory;
    };
    if (arguments) |provided| for (provided[0..argument_count], extra) |argument, *slot| {
        slot.* = allocator.dupe(u8, std.mem.span(argument orelse {
            command.arena.deinit();
            std.heap.c_allocator.destroy(command);
            return .invalid_argument;
        })) catch {
            command.arena.deinit();
            std.heap.c_allocator.destroy(command);
            return .out_of_memory;
        };
    };
    const runner = ctx.manifest.findRunner(requested_copy) orelse {
        ctx.setError(error.RunnerNotFound);
        command.arena.deinit();
        std.heap.c_allocator.destroy(command);
        return .not_found;
    };
    command.invocation = library.launch.prepareInvocation(allocator, ctx.io(), &ctx.environment, &ctx.manifest, runner, requested_copy, extra, internalTheme(theme_value)) catch |err| {
        ctx.setError(err);
        command.arena.deinit();
        std.heap.c_allocator.destroy(command);
        return statusForError(err);
    };
    command.io = ctx.io();
    ctx.clearError();
    destination.* = command;
    return .ok;
}

pub export fn terminal_theme_tools_command_destroy(command: ?*Command) callconv(.c) void {
    const value = command orelse return;
    value.invocation.deinit();
    value.arena.deinit();
    std.heap.c_allocator.destroy(value);
}

pub export fn terminal_theme_tools_command_argument_count(command: ?*const Command) callconv(.c) usize {
    return if (command) |value| value.invocation.argv.items.len else 0;
}

pub export fn terminal_theme_tools_command_argument(command: ?*const Command, argument_index: usize) callconv(.c) String {
    const value = command orelse return empty_string;
    if (argument_index >= value.invocation.argv.items.len) return empty_string;
    return view(value.invocation.argv.items[argument_index]);
}

pub export fn terminal_theme_tools_command_environment(command: ?*const Command, name: ?[*:0]const u8) callconv(.c) String {
    const value = command orelse return empty_string;
    return view(value.invocation.environment.get(std.mem.span(name orelse return empty_string)) orelse return empty_string);
}

pub export fn terminal_theme_tools_command_temporary_path(command: ?*const Command) callconv(.c) String {
    const value = command orelse return empty_string;
    return view(value.invocation.prepared.temporary_path orelse return empty_string);
}

pub export fn terminal_theme_tools_command_execute(command: ?*Command, out_exit_code: ?*u8) callconv(.c) Status {
    const value = command orelse return .invalid_argument;
    const destination = out_exit_code orelse return .invalid_argument;
    destination.* = value.invocation.execute(value.io) catch |err| return statusForError(err);
    return .ok;
}
