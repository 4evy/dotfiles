const std = @import("std");
const embedded = @import("embedded_data");
const c = @import("c");
const constants = @import("constants.zig");

pub const max_file_bytes = constants.filesystem.max_file_bytes;

pub const Pair = struct { key: []const u8, value: []const u8 };
pub const Command = []const []const u8;
pub const IntegrationStrategy = enum { arguments, config, environment };

pub const Runner = struct {
    name: []const u8,
    aliases: []const []const u8 = &.{},
    programs: []const []const u8 = &.{},
    skip_env: []const []const u8 = &.{},
    default_args: []const []const u8 = &.{},
    env: []const Pair = &.{},
    env_unset: []const []const u8 = &.{},
    integration: ?[]const u8 = null,
    interpreter: ?[]const u8 = null,
};

pub const Interpreter = struct {
    name: []const u8,
    shebang_commands: []const []const u8,
    shebang_arguments: []const []const u8,
    programs: []const []const u8,
};

pub const Integration = struct {
    name: []const u8,
    strategy: IntegrationStrategy,
    display_name: []const u8,
    dark_theme: []const u8,
    light_theme: []const u8,
    arguments: []const []const u8 = &.{},
    env: []const Pair = &.{},
    context_table: ?[]const u8 = null,
    context_field: ?[]const u8 = null,
    context_value: ?[]const u8 = null,
    context_path_flags: []const []const u8 = &.{},
    context_path_prefixes: []const []const u8 = &.{},
    context_argument_separator: ?[]const u8 = null,
    context_directory_commands: []const Command = &.{},
    default_config: ?[]const u8 = null,
    assignment: ?[]const u8 = null,
    config_flags: []const []const u8 = &.{},
    config_output_flag: ?[]const u8 = null,
    temporary_prefix: ?[]const u8 = null,
    temporary_location: ?enum { system, cache } = null,
    cache_subdirectory: ?[]const u8 = null,
    quote: ?u8 = null,
    validation: ?enum { toml } = null,
};

pub const Runtime = struct {
    theme_environment: []const []const u8,
    theme_dark_aliases: []const []const u8,
    theme_light_aliases: []const []const u8,
    theme_macos_commands: []const Command,
    theme_unix_commands: []const Command,
    theme_terminal_program_environment: []const u8,
    theme_terminal_queries: []const Pair,
    theme_macos_fallback: Theme,
    theme_unix_fallback: Theme,
    theme_probe_timeout_ms: u32,
    helper_timeout_ms: u32,
    helper_output_limit_bytes: usize,
};

pub const Theme = enum { dark, light };

pub const Manifest = struct {
    allocator: std.mem.Allocator,
    runners: std.ArrayList(Runner) = .empty,
    integrations: std.ArrayList(Integration) = .empty,
    interpreters: std.ArrayList(Interpreter) = .empty,
    runtime: Runtime,

    pub fn deinit(self: *Manifest) void {
        self.runners.deinit(self.allocator);
        self.integrations.deinit(self.allocator);
        self.interpreters.deinit(self.allocator);
    }

    pub fn findRunner(self: *const Manifest, command: []const u8) ?*const Runner {
        const base = std.fs.path.basename(command);
        for (self.runners.items) |*runner| {
            if (std.mem.eql(u8, base, runner.name)) return runner;
            for (runner.aliases) |alias| if (std.mem.eql(u8, base, alias)) return runner;
        }
        return null;
    }

    pub fn findIntegration(self: *const Manifest, name: []const u8) ?*const Integration {
        for (self.integrations.items) |*integration| {
            if (std.mem.eql(u8, integration.name, name)) return integration;
        }
        return null;
    }

    pub fn findInterpreter(self: *const Manifest, name: []const u8) ?*const Interpreter {
        for (self.interpreters.items) |*interpreter| {
            if (std.mem.eql(u8, interpreter.name, name)) return interpreter;
        }
        return null;
    }

    pub fn load(allocator: std.mem.Allocator, io: std.Io, env: *const std.process.Environ.Map) !Manifest {
        var manifest: Manifest = .{
            .allocator = allocator,
            .runtime = undefined,
        };
        errdefer manifest.deinit();

        try manifest.loadFragment(embedded.manifest, "embedded defaults.toml", true);

        if (env.get(constants.environment.config)) |paths| {
            var it = std.mem.splitScalar(u8, paths, std.fs.path.delimiter);
            while (it.next()) |path| if (path.len != 0) try manifest.loadOptionalFragment(io, path, true);
        } else if (env.get(constants.environment.xdg_config_home)) |xdg| {
            const path = try std.fs.path.join(allocator, &.{ xdg, constants.filesystem.config_directory, constants.filesystem.config_file });
            try manifest.loadOptionalFragment(io, path, true);
        } else if (env.get(constants.environment.home)) |home| {
            const path = try std.fs.path.join(allocator, &.{ home, constants.filesystem.default_path });
            try manifest.loadOptionalFragment(io, path, true);
        }

        try manifest.validate();
        return manifest;
    }

    pub fn loadText(allocator: std.mem.Allocator, override: ?[]const u8) !Manifest {
        var manifest: Manifest = .{
            .allocator = allocator,
            .runtime = undefined,
        };
        errdefer manifest.deinit();
        try manifest.loadFragment(embedded.manifest, "embedded defaults.toml", true);
        if (override) |contents| {
            if (contents.len != 0) try manifest.loadFragment(contents, "C API manifest", true);
        }
        try manifest.validate();
        return manifest;
    }

    fn loadOptionalFragment(self: *Manifest, io: std.Io, path: []const u8, comptime allow_runtime: bool) !void {
        const contents = readFile(self.allocator, io, path) catch |err| switch (err) {
            error.FileNotFound => return,
            else => return err,
        };
        try self.loadFragment(contents, path, allow_runtime);
    }

    fn loadFragment(self: *Manifest, contents: []const u8, source: []const u8, comptime allow_runtime: bool) !void {
        var doc = try Document.parse(self.allocator, contents, source);
        defer doc.deinit();
        try rejectUnknown(doc.root(), constants.toml.root_fields);

        const runtime = get(doc.root(), constants.toml.field.runtime);
        if (runtime.type != c.TOML_UNKNOWN) {
            if (!allow_runtime) return error.RuntimeOverrideNotAllowed;
            self.runtime = try parseRuntimeTable(self.allocator, runtime);
        }

        const interpreters = get(doc.root(), constants.toml.field.interpreter);
        if (interpreters.type != c.TOML_UNKNOWN) {
            if (interpreters.type != c.TOML_ARRAY) return error.InterpreterMustBeArray;
            var index: usize = 0;
            while (index < arrayLength(interpreters)) : (index += 1) {
                try putInterpreter(self, try parseInterpreter(self.allocator, interpreters.u.arr.elem[index]));
            }
        }

        const runners = get(doc.root(), constants.toml.field.runner);
        if (runners.type != c.TOML_UNKNOWN) {
            if (runners.type != c.TOML_ARRAY) return error.RunnerMustBeArray;
            var index: usize = 0;
            while (index < arrayLength(runners)) : (index += 1) {
                const runner = try parseRunner(self.allocator, runners.u.arr.elem[index]);
                try putRunner(self, runner);
            }
        }
        const integrations = get(doc.root(), constants.toml.field.integration);
        if (integrations.type != c.TOML_UNKNOWN) {
            if (integrations.type != c.TOML_ARRAY) return error.IntegrationMustBeArray;
            var index: usize = 0;
            while (index < arrayLength(integrations)) : (index += 1) {
                const integration = try parseIntegration(self.allocator, integrations.u.arr.elem[index]);
                try putIntegration(self, integration);
            }
        }
    }

    fn validate(self: *const Manifest) !void {
        for (self.runners.items, 0..) |runner, i| {
            if (runner.name.len == 0) return error.EmptyRunnerName;
            for (runner.aliases) |alias| if (alias.len == 0) return error.EmptyAlias;
            var j: usize = i + 1;
            while (j < self.runners.items.len) : (j += 1) {
                const other = self.runners.items[j];
                if (std.mem.eql(u8, runner.name, other.name)) return error.DuplicateRunnerName;
                if (contains(other.aliases, runner.name) or contains(runner.aliases, other.name)) return error.AliasCollision;
                for (runner.aliases) |alias| if (contains(other.aliases, alias)) return error.AliasCollision;
            }
            for (runner.aliases, 0..) |alias, a| {
                var b: usize = a + 1;
                while (b < runner.aliases.len) : (b += 1) if (std.mem.eql(u8, alias, runner.aliases[b])) return error.AliasCollision;
            }
            if (runner.integration) |name| if (self.findIntegration(name) == null) return error.MissingIntegration;
            if (runner.interpreter) |name| if (self.findInterpreter(name) == null) return error.MissingInterpreter;
        }
    }
};

fn contains(values: []const []const u8, needle: []const u8) bool {
    for (values) |value| if (std.mem.eql(u8, value, needle)) return true;
    return false;
}

fn putRunner(manifest: *Manifest, value: Runner) !void {
    for (manifest.runners.items) |*existing| {
        if (std.mem.eql(u8, existing.name, value.name)) {
            existing.* = value;
            return;
        }
    }
    try manifest.runners.append(manifest.allocator, value);
}

fn putIntegration(manifest: *Manifest, value: Integration) !void {
    for (manifest.integrations.items) |*existing| {
        if (std.mem.eql(u8, existing.name, value.name)) {
            existing.* = value;
            return;
        }
    }
    try manifest.integrations.append(manifest.allocator, value);
}

fn putInterpreter(manifest: *Manifest, value: Interpreter) !void {
    for (manifest.interpreters.items) |*existing| {
        if (std.mem.eql(u8, existing.name, value.name)) {
            existing.* = value;
            return;
        }
    }
    try manifest.interpreters.append(manifest.allocator, value);
}

const Document = struct {
    result: c.toml_result_t,
    allocator: std.mem.Allocator,
    text: [:0]u8,
    source: [:0]u8,

    fn parse(allocator: std.mem.Allocator, contents: []const u8, source: []const u8) !Document {
        if (contents.len > std.math.maxInt(c_int)) return error.FileTooBig;
        const text = try allocator.dupeZ(u8, contents);
        errdefer allocator.free(text);
        const source_z = try allocator.dupeZ(u8, source);
        errdefer allocator.free(source_z);
        const result = c.toml_parse_named(text.ptr, @intCast(contents.len), source_z.ptr);
        if (!result.ok) return error.InvalidToml;
        return .{ .result = result, .allocator = allocator, .text = text, .source = source_z };
    }

    fn deinit(self: *Document) void {
        c.toml_free(self.result);
        self.allocator.free(self.text);
        self.allocator.free(self.source);
    }

    fn root(self: *const Document) c.toml_datum_t {
        return self.result.toptab;
    }
};

fn get(table: c.toml_datum_t, key: [*:0]const u8) c.toml_datum_t {
    return c.toml_get(table, key);
}

fn arrayLength(value: c.toml_datum_t) usize {
    return if (value.u.arr.size < 0) 0 else @intCast(value.u.arr.size);
}

fn rejectUnknown(table: c.toml_datum_t, allowed: []const []const u8) !void {
    if (table.type != c.TOML_TABLE) return error.ExpectedTable;
    var i: usize = 0;
    while (i < @as(usize, @intCast(table.u.tab.size))) : (i += 1) {
        const key = std.mem.span(table.u.tab.key[i]);
        if (!contains(allowed, key)) return error.UnknownField;
    }
}

fn requiredString(allocator: std.mem.Allocator, table: c.toml_datum_t, key: [*:0]const u8) ![]const u8 {
    const value = get(table, key);
    if (value.type != c.TOML_STRING) return error.RequiredString;
    return allocator.dupe(u8, std.mem.span(value.u.s));
}

fn optionalString(allocator: std.mem.Allocator, table: c.toml_datum_t, key: [*:0]const u8) !?[]const u8 {
    const value = get(table, key);
    if (value.type == c.TOML_UNKNOWN) return null;
    if (value.type != c.TOML_STRING) return error.ExpectedString;
    const copy: []const u8 = try allocator.dupe(u8, std.mem.span(value.u.s));
    return copy;
}

fn stringArray(allocator: std.mem.Allocator, table: c.toml_datum_t, key: [*:0]const u8, required: bool) ![]const []const u8 {
    const value = get(table, key);
    if (value.type == c.TOML_UNKNOWN and !required) return &.{};
    if (value.type != c.TOML_ARRAY) return error.ExpectedStringArray;
    const result = try allocator.alloc([]const u8, arrayLength(value));
    for (result, 0..) |*slot, i| {
        const item = value.u.arr.elem[i];
        if (item.type != c.TOML_STRING) return error.ExpectedStringArray;
        slot.* = try allocator.dupe(u8, std.mem.span(item.u.s));
    }
    return result;
}

fn commandArray(allocator: std.mem.Allocator, table: c.toml_datum_t, key: [*:0]const u8, required: bool) ![]const Command {
    const value = get(table, key);
    if (value.type == c.TOML_UNKNOWN and !required) return &.{};
    if (value.type != c.TOML_ARRAY) return error.ExpectedCommandArray;
    const result = try allocator.alloc(Command, arrayLength(value));
    for (result, 0..) |*command, i| {
        const item = value.u.arr.elem[i];
        if (item.type != c.TOML_ARRAY or arrayLength(item) == 0) return error.ExpectedCommandArray;
        const argv = try allocator.alloc([]const u8, arrayLength(item));
        for (argv, 0..) |*arg, j| {
            const element = item.u.arr.elem[j];
            if (element.type != c.TOML_STRING or std.mem.span(element.u.s).len == 0) return error.ExpectedCommandArray;
            arg.* = try allocator.dupe(u8, std.mem.span(element.u.s));
        }
        command.* = argv;
    }
    return result;
}

fn stringMap(allocator: std.mem.Allocator, table: c.toml_datum_t, key: [*:0]const u8, required: bool) ![]const Pair {
    const value = get(table, key);
    if (value.type == c.TOML_UNKNOWN and !required) return &.{};
    if (value.type != c.TOML_TABLE) return error.ExpectedStringMap;
    const result = try allocator.alloc(Pair, @intCast(value.u.tab.size));
    for (result, 0..) |*pair, i| {
        const item = value.u.tab.value[i];
        if (item.type != c.TOML_STRING) return error.ExpectedStringMap;
        pair.* = .{
            .key = try allocator.dupe(u8, std.mem.span(value.u.tab.key[i])),
            .value = try allocator.dupe(u8, std.mem.span(item.u.s)),
        };
    }
    return result;
}

fn environment(allocator: std.mem.Allocator, table: c.toml_datum_t) ![]const Pair {
    const value = get(table, constants.toml.field.env);
    if (value.type == c.TOML_UNKNOWN) return &.{};
    if (value.type == c.TOML_TABLE) return stringMap(allocator, table, constants.toml.field.env, false);
    if (value.type != c.TOML_ARRAY) return error.ExpectedEnvironment;
    const result = try allocator.alloc(Pair, arrayLength(value));
    for (result, 0..) |*pair, i| {
        const item = value.u.arr.elem[i];
        if (item.type != c.TOML_STRING) return error.ExpectedEnvironment;
        const assignment = std.mem.span(item.u.s);
        const equal = std.mem.indexOfScalar(u8, assignment, '=') orelse return error.ExpectedEnvironment;
        if (equal == 0) return error.ExpectedEnvironment;
        pair.* = .{ .key = try allocator.dupe(u8, assignment[0..equal]), .value = try allocator.dupe(u8, assignment[equal + 1 ..]) };
    }
    return result;
}

fn validateEnvName(name: []const u8) !void {
    if (name.len == 0 or std.mem.indexOfScalar(u8, name, '=') != null) return error.InvalidEnvironmentName;
}

fn parseRunner(allocator: std.mem.Allocator, table: c.toml_datum_t) !Runner {
    try rejectUnknown(table, constants.toml.runner_fields);
    const runner: Runner = .{
        .name = try requiredString(allocator, table, constants.toml.field.name),
        .aliases = try stringArray(allocator, table, constants.toml.field.aliases, false),
        .programs = try stringArray(allocator, table, constants.toml.field.programs, false),
        .skip_env = try stringArray(allocator, table, constants.toml.field.skip_env, false),
        .default_args = try stringArray(allocator, table, constants.toml.field.default_args, false),
        .env = try environment(allocator, table),
        .env_unset = try stringArray(allocator, table, constants.toml.field.env_unset, false),
        .integration = try optionalString(allocator, table, constants.toml.field.integration),
        .interpreter = try optionalString(allocator, table, constants.toml.field.interpreter),
    };
    for (runner.skip_env) |name| try validateEnvName(name);
    for (runner.env_unset) |name| try validateEnvName(name);
    for (runner.env) |pair| try validateEnvName(pair.key);
    for (runner.programs) |program| if (std.mem.eql(u8, program, "$")) return error.InvalidProgramReference;
    return runner;
}

fn parseInterpreter(allocator: std.mem.Allocator, table: c.toml_datum_t) !Interpreter {
    try rejectUnknown(table, constants.toml.interpreter_fields);
    const result: Interpreter = .{
        .name = try requiredString(allocator, table, constants.toml.field.name),
        .shebang_commands = try stringArray(allocator, table, constants.toml.field.shebang_commands, true),
        .shebang_arguments = try stringArray(allocator, table, constants.toml.field.shebang_arguments, true),
        .programs = try stringArray(allocator, table, constants.toml.field.programs, true),
    };
    if (result.name.len == 0 or result.shebang_commands.len == 0 or result.shebang_arguments.len == 0 or result.programs.len == 0) return error.InvalidInterpreter;
    return result;
}

fn parseIntegration(allocator: std.mem.Allocator, table: c.toml_datum_t) !Integration {
    try rejectUnknown(table, constants.toml.integration_fields);
    const name = try requiredString(allocator, table, constants.toml.field.name);
    const strategy_text = try requiredString(allocator, table, constants.toml.field.strategy);
    const strategy: IntegrationStrategy = if (std.mem.eql(u8, strategy_text, constants.toml.arguments_strategy))
        .arguments
    else if (std.mem.eql(u8, strategy_text, constants.toml.config_strategy))
        .config
    else if (std.mem.eql(u8, strategy_text, constants.toml.environment_strategy))
        .environment
    else
        return error.UnsupportedStrategy;
    const display_name = (try optionalString(allocator, table, constants.toml.field.display_name)) orelse name;
    const quote_text = try optionalString(allocator, table, constants.toml.field.quote);
    const location_text = try optionalString(allocator, table, constants.toml.field.temporary_location);
    const validation_text = try optionalString(allocator, table, constants.toml.field.validation);
    var result: Integration = .{
        .name = name,
        .strategy = strategy,
        .display_name = display_name,
        .dark_theme = try requiredString(allocator, table, constants.toml.field.dark_theme),
        .light_theme = try requiredString(allocator, table, constants.toml.field.light_theme),
        .arguments = try stringArray(allocator, table, constants.toml.field.arguments, false),
        .env = try environment(allocator, table),
        .context_table = try optionalString(allocator, table, constants.toml.field.context_table),
        .context_field = try optionalString(allocator, table, constants.toml.field.context_field),
        .context_value = try optionalString(allocator, table, constants.toml.field.context_value),
        .context_path_flags = try stringArray(allocator, table, constants.toml.field.context_path_flags, false),
        .context_path_prefixes = try stringArray(allocator, table, constants.toml.field.context_path_prefixes, false),
        .context_argument_separator = try optionalString(allocator, table, constants.toml.field.context_argument_separator),
        .context_directory_commands = try commandArray(allocator, table, constants.toml.field.context_directory_commands, false),
        .default_config = try optionalString(allocator, table, constants.toml.field.default_config),
        .assignment = try optionalString(allocator, table, constants.toml.field.assignment),
        .config_flags = try stringArray(allocator, table, constants.toml.field.config_flags, false),
        .config_output_flag = try optionalString(allocator, table, constants.toml.field.config_output_flag),
        .temporary_prefix = try optionalString(allocator, table, constants.toml.field.temporary_prefix),
        .cache_subdirectory = try optionalString(allocator, table, constants.toml.field.cache_subdirectory),
    };
    if (quote_text) |quote| {
        if (quote.len != 1 or (quote[0] != '\'' and quote[0] != '"')) return error.InvalidQuote;
        result.quote = quote[0];
    }
    if (location_text) |location| result.temporary_location = if (std.mem.eql(u8, location, constants.toml.system_location)) .system else if (std.mem.eql(u8, location, constants.toml.cache_location)) .cache else return error.InvalidTemporaryLocation;
    if (validation_text) |validation| result.validation = if (std.mem.eql(u8, validation, constants.toml.toml_validation)) .toml else return error.InvalidValidation;
    for (result.env) |pair| try validateEnvName(pair.key);
    try validateIntegration(result);
    return result;
}

fn hasPlaceholder(values: []const []const u8, placeholder: []const u8) bool {
    for (values) |value| if (std.mem.indexOf(u8, value, placeholder) != null) return true;
    return false;
}

fn validateIntegration(value: Integration) !void {
    if (value.name.len == 0 or value.dark_theme.len == 0 or value.light_theme.len == 0) return error.EmptyIntegrationField;
    switch (value.strategy) {
        .arguments => {
            if (value.arguments.len == 0 or !hasPlaceholder(value.arguments, constants.template.theme)) return error.InvalidArgumentIntegration;
            const context_count = @as(u8, @intFromBool(value.context_table != null)) + @as(u8, @intFromBool(value.context_field != null)) + @as(u8, @intFromBool(value.context_value != null));
            if (context_count != 0 and context_count != 3) return error.InvalidContextPolicy;
            if (context_count == 3 and !hasPlaceholder(value.arguments, constants.template.context)) return error.InvalidContextPolicy;
            for (value.context_directory_commands) |command| {
                var found = false;
                for (command) |arg| {
                    if (std.mem.indexOf(u8, arg, constants.template.directory) != null) found = true;
                }
                if (!found) return error.InvalidContextCommand;
            }
        },
        .config => {
            if (value.default_config == null or value.assignment == null or value.config_flags.len == 0 or value.config_output_flag == null or value.temporary_prefix == null or value.temporary_location == null or value.quote == null) return error.InvalidConfigIntegration;
            if (!std.mem.endsWith(u8, value.temporary_prefix.?, constants.toml.temporary_suffix) or std.fs.path.basename(value.temporary_prefix.?).len != value.temporary_prefix.?.len) return error.InvalidTemporaryPrefix;
            if (value.temporary_location.? == .cache and value.cache_subdirectory == null) return error.InvalidConfigIntegration;
        },
        .environment => {
            if (value.env.len == 0) return error.InvalidEnvironmentIntegration;
            var has_theme = false;
            for (value.env) |pair| if (std.mem.indexOf(u8, pair.value, constants.template.theme) != null) {
                has_theme = true;
            };
            if (!has_theme) return error.InvalidEnvironmentIntegration;
        },
    }
}

fn parseTheme(value: []const u8) !Theme {
    if (std.mem.eql(u8, value, constants.toml.dark)) return .dark;
    if (std.mem.eql(u8, value, constants.toml.light)) return .light;
    return error.InvalidTheme;
}

fn requiredInt(table: c.toml_datum_t, key: [*:0]const u8, maximum: u64) !u64 {
    const value = get(table, key);
    if (value.type != c.TOML_INT64 or value.u.int64 <= 0 or value.u.int64 > maximum) return error.InvalidRuntimeLimit;
    return @intCast(value.u.int64);
}

fn parseRuntimeTable(allocator: std.mem.Allocator, table: c.toml_datum_t) !Runtime {
    try rejectUnknown(table, constants.toml.runtime_fields);
    return parseRuntimeFields(allocator, table);
}

fn parseRuntimeFields(allocator: std.mem.Allocator, table: c.toml_datum_t) !Runtime {
    const macos_fallback = try requiredString(allocator, table, constants.toml.field.theme_macos_fallback);
    const unix_fallback = try requiredString(allocator, table, constants.toml.field.theme_unix_fallback);
    const result: Runtime = .{
        .theme_environment = try stringArray(allocator, table, constants.toml.field.theme_environment, true),
        .theme_dark_aliases = try stringArray(allocator, table, constants.toml.field.theme_dark_aliases, true),
        .theme_light_aliases = try stringArray(allocator, table, constants.toml.field.theme_light_aliases, true),
        .theme_macos_commands = try commandArray(allocator, table, constants.toml.field.theme_macos_commands, true),
        .theme_unix_commands = try commandArray(allocator, table, constants.toml.field.theme_unix_commands, true),
        .theme_terminal_program_environment = try requiredString(allocator, table, constants.toml.field.theme_terminal_program_environment),
        .theme_terminal_queries = try stringMap(allocator, table, constants.toml.field.theme_terminal_queries, true),
        .theme_macos_fallback = try parseTheme(macos_fallback),
        .theme_unix_fallback = try parseTheme(unix_fallback),
        .theme_probe_timeout_ms = @intCast(try requiredInt(table, constants.toml.field.theme_probe_timeout_ms, constants.toml.runtime_limit_maximum)),
        .helper_timeout_ms = @intCast(try requiredInt(table, constants.toml.field.helper_timeout_ms, constants.toml.runtime_limit_maximum)),
        .helper_output_limit_bytes = @intCast(try requiredInt(table, constants.toml.field.helper_output_limit_bytes, max_file_bytes)),
    };
    if (result.theme_environment.len == 0) return error.InvalidRuntime;
    var has_fallback = false;
    for (result.theme_terminal_queries) |pair| {
        if (std.mem.eql(u8, pair.key, constants.protocol.wildcard)) has_fallback = true;
        if (!std.mem.eql(u8, pair.value, constants.protocol.background) and !std.mem.eql(u8, pair.value, constants.protocol.color_scheme)) return error.InvalidTerminalProtocol;
    }
    if (!has_fallback) return error.MissingTerminalFallback;
    return result;
}

fn readFile(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(max_file_bytes));
}

pub fn validateToml(allocator: std.mem.Allocator, contents: []const u8, source: []const u8) !void {
    var document = try Document.parse(allocator, contents, source);
    document.deinit();
}

pub const TomlAssignment = struct {
    kind: enum { missing, string, table },
    line: ?usize,
};

pub fn inspectTomlAssignment(allocator: std.mem.Allocator, contents: []const u8, source: []const u8, key: [:0]const u8) !TomlAssignment {
    var document = try Document.parse(allocator, contents, source);
    defer document.deinit();
    const value = get(document.root(), key.ptr);
    return switch (value.type) {
        c.TOML_UNKNOWN => .{ .kind = .missing, .line = null },
        c.TOML_STRING => .{ .kind = .string, .line = if (value.lineno > 0) @intCast(value.lineno) else null },
        c.TOML_TABLE => .{ .kind = .table, .line = if (value.lineno > 0) @intCast(value.lineno) else null },
        else => error.AssignmentMustBeString,
    };
}

test "embedded manifest contains only generic runtime defaults" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    var manifest = try Manifest.load(allocator, std.testing.io, &env);
    defer manifest.deinit();
    try std.testing.expectEqual(0, manifest.runners.items.len);
    try std.testing.expectEqual(0, manifest.integrations.items.len);
    try std.testing.expectEqual(0, manifest.interpreters.items.len);
}

test "nested command arrays reject shell strings" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const bad =
        \\[runtime]
        \\theme_macos_commands = ["single shell string"]
        \\theme_environment=["THEME"]
        \\theme_dark_aliases=[]
        \\theme_light_aliases=[]
        \\theme_unix_commands=[]
        \\theme_terminal_program_environment="TERM_PROGRAM"
        \\theme_terminal_queries={"*"="background"}
        \\theme_macos_fallback="dark"
        \\theme_unix_fallback="dark"
        \\theme_probe_timeout_ms=1
        \\helper_timeout_ms=1
        \\helper_output_limit_bytes=1
    ;
    var document = try Document.parse(arena.allocator(), bad, "test");
    defer document.deinit();
    try std.testing.expectError(error.ExpectedCommandArray, parseRuntimeTable(arena.allocator(), get(document.root(), constants.toml.field.runtime)));
}

test "runner aliases are globally unique" {
    const runtime: Runtime = undefined;
    var manifest: Manifest = .{ .allocator = std.testing.allocator, .runtime = runtime };
    defer manifest.deinit();
    try manifest.runners.append(std.testing.allocator, .{ .name = "primary", .aliases = &.{"alias"} });
    try manifest.runners.append(std.testing.allocator, .{ .name = "alias" });
    try std.testing.expectError(error.AliasCollision, manifest.validate());
}

fn temporaryPath(allocator: std.mem.Allocator, temporary: *std.testing.TmpDir, relative: []const u8) ![]const u8 {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const length = try temporary.dir.realPath(std.testing.io, &buffer);
    return std.fs.path.join(allocator, &.{ buffer[0..length], relative });
}

test "explicit configuration paths merge in order" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    try temporary.dir.writeFile(std.testing.io, .{
        .sub_path = "first.toml",
        .data = "[[runner]]\nname = \"tool\"\naliases = [\"first-alias\"]\nprograms = [\"first\"]\n",
    });
    try temporary.dir.writeFile(std.testing.io, .{
        .sub_path = "second.toml",
        .data = "[[runner]]\nname = \"tool\"\naliases = [\"last-alias\"]\nprograms = [\"last\"]\n",
    });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const first = try temporaryPath(arena.allocator(), &temporary, "first.toml");
    const second = try temporaryPath(arena.allocator(), &temporary, "second.toml");
    const delimiter = [_]u8{std.fs.path.delimiter};
    const paths = try std.mem.join(arena.allocator(), &delimiter, &.{ first, second });
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(constants.environment.config, paths);
    var manifest = try Manifest.load(arena.allocator(), std.testing.io, &env);
    defer manifest.deinit();
    try std.testing.expect(manifest.findRunner("first-alias") == null);
    const runner = manifest.findRunner("last-alias").?;
    try std.testing.expectEqualStrings("last", runner.programs[0]);
}

test "XDG configuration adds a profile" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    try temporary.dir.createDirPath(std.testing.io, constants.filesystem.config_directory);
    try temporary.dir.writeFile(std.testing.io, .{
        .sub_path = "terminal-theme-run/config.toml",
        .data = "[[runner]]\nname = \"custom-tool\"\naliases = [\"custom-alias\"]\nprograms = [\"custom-binary\"]\n",
    });

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const directory = try temporaryPath(arena.allocator(), &temporary, "");
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put(constants.environment.xdg_config_home, directory);
    var manifest = try Manifest.load(arena.allocator(), std.testing.io, &env);
    defer manifest.deinit();
    try std.testing.expectEqualStrings("custom-binary", manifest.findRunner("custom-alias").?.programs[0]);
}
