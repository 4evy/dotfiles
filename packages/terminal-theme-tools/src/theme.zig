const std = @import("std");
const vt = @import("ghostty-vt");
const config = @import("config.zig");
const constants = @import("constants.zig");
const c = @import("c");

pub const ReportParser = struct {
    parser: vt.Parser,
    mode: ?config.Theme = null,

    pub fn init(allocator: std.mem.Allocator) ReportParser {
        var parser = vt.Parser.init();
        parser.osc_parser.alloc = allocator;
        return .{ .parser = parser };
    }

    pub fn deinit(self: *ReportParser) void {
        self.parser.deinit();
    }

    pub fn feed(self: *ReportParser, bytes: []const u8) ?config.Theme {
        for (bytes) |byte| {
            const actions = self.parser.next(byte);
            for (actions) |maybe_action| if (maybe_action) |action| switch (action) {
                .csi_dispatch => |csi| self.consumeCsi(csi),
                .osc_dispatch => |osc| self.consumeOsc(osc),
                else => {},
            };
            if (self.mode != null) return self.mode;
        }
        return self.mode;
    }

    fn consumeCsi(self: *ReportParser, csi: vt.Parser.Action.CSI) void {
        if (csi.final != 'n' or !std.mem.eql(u8, csi.intermediates, "?") or csi.params.len != 2 or csi.params[0] != constants.protocol.color_scheme_report_parameter) return;
        self.mode = switch (csi.params[1]) {
            constants.protocol.dark_report_value => .dark,
            constants.protocol.light_report_value => .light,
            else => null,
        };
    }

    fn consumeOsc(self: *ReportParser, osc: vt.osc.Command) void {
        if (osc != .color_operation or osc.color_operation.op != .osc_11) return;
        var iterator = osc.color_operation.requests.constIterator(0);
        while (iterator.next()) |request| switch (request.*) {
            .set => |colored| switch (colored.target) {
                .dynamic => |dynamic| if (dynamic == .background) {
                    const rgb = colored.color;
                    const luminance = (constants.protocol.luminance_red * @as(f64, @floatFromInt(rgb.r)) + constants.protocol.luminance_green * @as(f64, @floatFromInt(rgb.g)) + constants.protocol.luminance_blue * @as(f64, @floatFromInt(rgb.b))) / constants.protocol.color_channel_maximum;
                    self.mode = if (luminance > constants.protocol.light_luminance_threshold) .light else .dark;
                    return;
                },
                else => {},
            },
            else => {},
        };
    }
};

pub fn parseReport(allocator: std.mem.Allocator, bytes: []const u8) ?config.Theme {
    var parser = ReportParser.init(allocator);
    defer parser.deinit();
    return parser.feed(bytes);
}

pub fn modeFromText(runtime: *const config.Runtime, text: ?[]const u8) ?config.Theme {
    const raw = text orelse return null;
    var buffer: [constants.filesystem.mode_text_bytes]u8 = undefined;
    if (raw.len > buffer.len) return null;
    for (raw, 0..) |byte, i| buffer[i] = std.ascii.toLower(byte);
    var normalized = std.mem.trim(u8, buffer[0..raw.len], constants.text.whitespace);
    if (std.mem.indexOf(u8, normalized, constants.toml.dark) != null) return .dark;
    if (std.mem.indexOf(u8, normalized, constants.toml.light) != null) return .light;
    if (normalized.len >= 2 and ((normalized[0] == '\'' and normalized[normalized.len - 1] == '\'') or (normalized[0] == '"' and normalized[normalized.len - 1] == '"'))) normalized = normalized[1 .. normalized.len - 1];
    for (runtime.theme_dark_aliases) |alias| if (std.ascii.eqlIgnoreCase(normalized, alias)) return .dark;
    for (runtime.theme_light_aliases) |alias| if (std.ascii.eqlIgnoreCase(normalized, alias)) return .light;
    return null;
}

fn protocol(runtime: *const config.Runtime, identifier: ?[]const u8) ?[]const u8 {
    const name = identifier orelse return null;
    for (runtime.theme_terminal_queries) |pair| if (std.ascii.eqlIgnoreCase(pair.key, name)) return pair.value;
    return null;
}

pub fn terminalQuery(runtime: *const config.Runtime, env: *const std.process.Environ.Map) []const u8 {
    const selected = protocol(runtime, env.get(runtime.theme_terminal_program_environment)) orelse protocol(runtime, env.get(constants.protocol.terminal_environment)) orelse fallback: {
        for (runtime.theme_terminal_queries) |pair| if (std.mem.eql(u8, pair.key, constants.protocol.wildcard)) break :fallback pair.value;
        break :fallback constants.protocol.background;
    };
    return if (std.mem.eql(u8, selected, constants.protocol.color_scheme)) constants.protocol.color_scheme_query else constants.protocol.background_query;
}

fn monotonicMilliseconds() i64 {
    var ts: c.struct_timespec = undefined;
    if (c.clock_gettime(c.CLOCK_MONOTONIC, &ts) != 0) return 0;
    return @as(i64, @intCast(ts.tv_sec)) * constants.protocol.milliseconds_per_second + @divTrunc(@as(i64, @intCast(ts.tv_nsec)), constants.protocol.nanoseconds_per_millisecond);
}

fn writeAll(fd: c_int, bytes: []const u8) bool {
    var written: usize = 0;
    while (written < bytes.len) {
        const count = c.write(fd, bytes[written..].ptr, bytes.len - written);
        if (count < 0 and std.c.errno(count) == .INTR) continue;
        if (count <= 0) return false;
        written += @intCast(count);
    }
    return true;
}

fn probeTerminal(allocator: std.mem.Allocator, fd: c_int, query: []const u8, timeout_ms: u32) ?config.Theme {
    if (!writeAll(fd, query)) return null;
    var parser = ReportParser.init(allocator);
    defer parser.deinit();
    var buffer: [constants.protocol.terminal_buffer_bytes]u8 = undefined;
    var used: usize = 0;
    const deadline = monotonicMilliseconds() + timeout_ms;
    while (used < buffer.len) {
        const remaining = deadline - monotonicMilliseconds();
        if (remaining <= 0) break;
        var event = c.struct_pollfd{ .fd = fd, .events = c.POLLIN, .revents = 0 };
        const ready = c.poll(&event, 1, @intCast(@min(remaining, std.math.maxInt(c_int))));
        if (ready < 0 and std.c.errno(ready) == .INTR) continue;
        if (ready <= 0 or event.revents & c.POLLIN == 0) break;
        const count = c.read(fd, buffer[used..].ptr, buffer.len - used);
        if (count < 0 and std.c.errno(count) == .INTR) continue;
        if (count <= 0) break;
        const start = used;
        used += @intCast(count);
        if (parser.feed(buffer[start..used])) |mode| return mode;
    }
    return parser.mode;
}

fn detectTerminal(allocator: std.mem.Allocator, runtime: *const config.Runtime, env: *const std.process.Environ.Map) ?config.Theme {
    const fd = c.open(constants.filesystem.controlling_terminal, c.O_RDWR | c.O_CLOEXEC);
    if (fd < 0) return null;
    defer _ = c.close(fd);
    var saved: c.struct_termios = undefined;
    if (c.tcgetattr(fd, &saved) != 0) return null;
    var raw = saved;
    c.cfmakeraw(&raw);
    if (c.tcsetattr(fd, c.TCSADRAIN, &raw) != 0) return null;
    defer _ = c.tcsetattr(fd, c.TCSADRAIN, &saved);

    const query = terminalQuery(runtime, env);
    if (probeTerminal(allocator, fd, query, runtime.theme_probe_timeout_ms)) |mode| return mode;

    // Kitty's color-scheme query reports the user's appearance preference and
    // is therefore preferable to inferring it from a background color. Some
    // multiplexers do not forward that query even when TERM_PROGRAM/TERM
    // identify Kitty or Ghostty, so retry with the
    // widely supported OSC 11 query before falling back to the desktop.
    if (std.mem.eql(u8, query, constants.protocol.color_scheme_query)) {
        return probeTerminal(allocator, fd, constants.protocol.background_query, runtime.theme_probe_timeout_ms);
    }
    return null;
}

fn commandMode(allocator: std.mem.Allocator, io: std.Io, runtime: *const config.Runtime, env: *const std.process.Environ.Map, command: config.Command) ?config.Theme {
    const result = std.process.run(allocator, io, .{
        .argv = command,
        .environ_map = env,
        .stdout_limit = .limited(runtime.helper_output_limit_bytes),
        .stderr_limit = .limited(runtime.helper_output_limit_bytes),
        .timeout = helperTimeout(runtime.helper_timeout_ms),
    }) catch return null;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (result.term != .exited or result.term.exited != 0) return null;
    return modeFromText(runtime, result.stdout);
}

fn helperTimeout(milliseconds: u32) std.Io.Timeout {
    return .{ .duration = .{ .raw = .fromMilliseconds(milliseconds), .clock = .awake } };
}

fn detectConfiguredEnvironment(runtime: *const config.Runtime, env: *const std.process.Environ.Map) ?config.Theme {
    for (runtime.theme_environment) |name| if (modeFromText(runtime, env.get(name))) |mode| return mode;
    return null;
}

pub fn detectWithoutTerminal(allocator: std.mem.Allocator, io: std.Io, runtime: *const config.Runtime, env: *const std.process.Environ.Map) config.Theme {
    if (detectConfiguredEnvironment(runtime, env)) |mode| return mode;
    const policy = switch (@import("builtin").os.tag) {
        .macos => .{ runtime.theme_macos_commands, runtime.theme_macos_fallback },
        else => .{ runtime.theme_unix_commands, runtime.theme_unix_fallback },
    };
    for (policy[0]) |command| if (commandMode(allocator, io, runtime, env, command)) |mode| return mode;
    return policy[1];
}

pub fn detect(allocator: std.mem.Allocator, io: std.Io, runtime: *const config.Runtime, env: *const std.process.Environ.Map) config.Theme {
    if (detectConfiguredEnvironment(runtime, env)) |mode| return mode;
    if (detectTerminal(allocator, runtime, env)) |mode| return mode;
    return detectWithoutTerminal(allocator, io, runtime, env);
}

test "VT parser handles color scheme responses and fragmentation" {
    var parser = ReportParser.init(std.testing.allocator);
    defer parser.deinit();
    try std.testing.expect(parser.feed("noise\x1b[?997;") == null);
    try std.testing.expectEqual(config.Theme.dark, parser.feed("1n").?);
    try std.testing.expectEqual(config.Theme.light, parseReport(std.testing.allocator, "\x1b[?997;2n").?);
}

test "VT parser handles background color component widths" {
    const cases = [_]struct { report: []const u8, expected: config.Theme }{
        .{ .report = "\x1b]11;rgb:efff/f1f1/f5f5\x07", .expected = .light },
        .{ .report = "prefix\x1b]11;rgb:3030/3434/4646\x1b\\suffix", .expected = .dark },
        .{ .report = "\x1b]11;rgb:f/f/f\x07", .expected = .light },
        .{ .report = "\x1b]11;rgb:ef/f1/f5\x07", .expected = .light },
        .{ .report = "\x1b]11;rgb:000/000/000\x07", .expected = .dark },
        .{ .report = "\x1b]11;rgb:30/34/46\x07", .expected = .dark },
        .{ .report = "\x1b]11;rgb:80/80/80\x07", .expected = .light },
        .{ .report = "\x1b]11;rgb:7f/7f/7f\x07", .expected = .dark },
    };
    for (cases) |case| try std.testing.expectEqual(case.expected, parseReport(std.testing.allocator, case.report).?);
}

test "VT parser rejects malformed terminal reports" {
    const invalid = [_][]const u8{
        "\x1b]11;rgb:/ff/ff\x07",
        "\x1b]11;rgb:fffff/ff/ff\x07",
        "\x1b]11;rgb:gg/ff/ff\x07",
        "\x1b]11;rgb:ff/ff/ff/ff\x07",
        "\x1b[997;1n",
        "\x1b[?997;1;2n",
        "\x1b[?997;1m",
        "\x1b]11;rgb:ff/ff/ff",
        "\x1b]11;rgb:ff/ff/ff\x00ignored\x07",
    };
    for (invalid) |report| try std.testing.expect(parseReport(std.testing.allocator, report) == null);
}

test "terminal query selection supports Kitty, Ghostty, and OSC fallback" {
    const runtime: config.Runtime = .{
        .theme_environment = &.{"THEME"},
        .theme_dark_aliases = &.{},
        .theme_light_aliases = &.{},
        .theme_macos_commands = &.{},
        .theme_unix_commands = &.{},
        .theme_terminal_program_environment = "TERM_PROGRAM",
        .theme_terminal_queries = &.{
            .{ .key = "ghostty", .value = constants.protocol.color_scheme },
            .{ .key = "xterm-ghostty", .value = constants.protocol.color_scheme },
            .{ .key = "kitty", .value = constants.protocol.color_scheme },
            .{ .key = "xterm-kitty", .value = constants.protocol.color_scheme },
            .{ .key = constants.protocol.wildcard, .value = constants.protocol.background },
        },
        .theme_macos_fallback = .dark,
        .theme_unix_fallback = .dark,
        .theme_probe_timeout_ms = 1,
        .helper_timeout_ms = 1,
        .helper_output_limit_bytes = 128,
    };
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();

    try env.put("TERM_PROGRAM", "Ghostty");
    try env.put(constants.protocol.terminal_environment, "xterm-256color");
    try std.testing.expectEqualStrings(constants.protocol.color_scheme_query, terminalQuery(&runtime, &env));

    try env.put("TERM_PROGRAM", "unknown-terminal");
    try env.put(constants.protocol.terminal_environment, "xterm-kitty");
    try std.testing.expectEqualStrings(constants.protocol.color_scheme_query, terminalQuery(&runtime, &env));

    try env.put("TERM_PROGRAM", "");
    try env.put(constants.protocol.terminal_environment, "xterm-ghostty");
    try std.testing.expectEqualStrings(constants.protocol.color_scheme_query, terminalQuery(&runtime, &env));

    try env.put("TERM_PROGRAM", "unknown-terminal");
    try env.put(constants.protocol.terminal_environment, "xterm-256color");
    try std.testing.expectEqualStrings(constants.protocol.background_query, terminalQuery(&runtime, &env));
}
