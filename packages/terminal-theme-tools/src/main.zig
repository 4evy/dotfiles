const std = @import("std");
const library = @import("terminal_theme_tools");
const config = library.config;
const constants = library.constants;
const launch = library.launch;

const help = std.fmt.comptimePrint(
    \\Usage: {s} [{s}|{s}|{s}|{s}] [{s}] COMMAND [ARG...]
    \\
    \\{s}
    \\
    \\Options:
    \\  {s}     Show this help
    \\  {s}  Print the detected terminal theme (`dark` or `light`)
    \\  {s}  Print the theme without reading terminal input
    \\  {s}  Show program version
    \\
, .{
    constants.application.name,
    constants.cli.help_option,
    constants.cli.print_theme_option,
    constants.cli.print_theme_no_terminal_option,
    constants.cli.version_option,
    constants.cli.separator,
    constants.application.description,
    constants.cli.help_option,
    constants.cli.print_theme_option,
    constants.cli.print_theme_no_terminal_option,
    constants.cli.version_option,
});

pub fn main(init: std.process.Init) void {
    const status = run(init) catch |err| {
        std.debug.print(constants.application.name ++ ": {s}\n", .{@errorName(err)});
        return std.process.exit(constants.exit.failure);
    };
    std.process.exit(status);
}

fn printStdout(io: std.Io, text: []const u8) !void {
    try std.Io.File.stdout().writeStreamingAll(io, text);
}

fn run(init: std.process.Init) !u8 {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    if (args.len <= constants.cli.first_argument_index) {
        try printStdout(init.io, help);
        return constants.exit.success;
    }

    var command_index: usize = constants.cli.first_argument_index;
    if (std.mem.eql(u8, args[command_index], constants.cli.help_option)) {
        try printStdout(init.io, help);
        return constants.exit.success;
    }
    if (std.mem.eql(u8, args[command_index], constants.cli.version_option)) {
        try printStdout(init.io, constants.application.name ++ " version " ++ constants.application.version ++ "\n");
        return constants.exit.success;
    }
    const print_theme = std.mem.eql(u8, args[command_index], constants.cli.print_theme_option);
    const print_theme_no_terminal = std.mem.eql(u8, args[command_index], constants.cli.print_theme_no_terminal_option);
    if (print_theme or print_theme_no_terminal) {
        if (args.len != constants.cli.first_argument_index + 1) {
            std.debug.print(constants.application.name ++ ": {s} does not accept arguments\n", .{args[command_index]});
            return constants.exit.usage;
        }
        var manifest = config.Manifest.load(allocator, init.io, init.environ_map) catch |err| {
            std.debug.print(constants.application.name ++ ": failed to load configuration: {s}\n", .{@errorName(err)});
            return constants.exit.failure;
        };
        defer manifest.deinit();
        const detected = if (print_theme_no_terminal)
            library.theme.detectWithoutTerminal(allocator, init.io, &manifest.runtime, init.environ_map)
        else
            library.theme.detect(allocator, init.io, &manifest.runtime, init.environ_map);
        try printStdout(init.io, @tagName(detected));
        try printStdout(init.io, "\n");
        return constants.exit.success;
    }
    if (std.mem.eql(u8, args[command_index], constants.cli.separator)) {
        command_index += 1;
        if (command_index >= args.len) {
            try printStdout(init.io, help);
            return constants.exit.success;
        }
    } else if (std.mem.startsWith(u8, args[command_index], constants.cli.option_prefix)) {
        std.debug.print(constants.application.name ++ ": unknown option: {s}\n", .{args[command_index]});
        return constants.exit.usage;
    }

    var manifest = config.Manifest.load(allocator, init.io, init.environ_map) catch |err| {
        std.debug.print(constants.application.name ++ ": failed to load configuration: {s}\n", .{@errorName(err)});
        return constants.exit.failure;
    };
    defer manifest.deinit();
    const command = args[command_index];
    if (manifest.findRunner(command)) |runner| {
        return launch.runMatched(allocator, init.io, init.environ_map, &manifest, runner, command, args[command_index + 1 ..]) catch |err| {
            std.debug.print(constants.application.name ++ ": failed to run {s}: {s}\n", .{ command, @errorName(err) });
            return if (err == error.FileNotFound) constants.exit.not_found else constants.exit.cannot_execute;
        };
    }
    return launch.execUnknown(allocator, args[command_index..]);
}
