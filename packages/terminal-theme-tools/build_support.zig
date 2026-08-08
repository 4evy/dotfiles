const std = @import("std");
const builtin = @import("builtin");
const constants = @import("src/constants.zig");

const executable_name = constants.application.name;
const library_name = "terminal_theme_tools";
const version = constants.application.version;
const tomlc17_flags = &.{ "-std=c17", "-Wall", "-Wextra", "-Werror" };
const c_api_flags = &.{ "-std=c23", "-pedantic-errors", "-Wall", "-Wextra", "-Werror" };

fn sourcePath(b: *std.Build, base: []const u8, relative: []const u8) std.Build.LazyPath {
    return b.path(b.pathJoin(&.{ base, relative }));
}

pub fn configure(b: *std.Build, base: []const u8) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSmall });
    const ghostty = b.dependency("ghostty", .{ .simd = false });

    const translated_c = b.addTranslateC(.{
        .root_source_file = sourcePath(b, base, "src/platform.h"),
        .target = target,
        .optimize = optimize,
    });
    translated_c.addIncludePath(sourcePath(b, base, "vendor/tomlc17"));

    const embedded = b.addOptions();
    embedded.addOption([]const u8, "manifest", @embedFile("config/defaults.toml"));

    const core = b.createModule(.{
        .root_source_file = sourcePath(b, base, "src/lib.zig"),
        .target = target,
        .optimize = optimize,
        .strip = optimize != .Debug,
        .link_libc = true,
        .imports = &.{
            .{ .name = "c", .module = translated_c.createModule() },
            .{ .name = "embedded_data", .module = embedded.createModule() },
            .{ .name = "ghostty-vt", .module = ghostty.module("ghostty-vt") },
        },
    });
    core.addIncludePath(sourcePath(b, base, "vendor/tomlc17"));
    core.addCSourceFile(.{
        .file = sourcePath(b, base, "vendor/tomlc17/tomlc17.c"),
        .flags = tomlc17_flags,
    });

    const executable_module = b.createModule(.{
        .root_source_file = sourcePath(b, base, "src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = optimize != .Debug,
        .link_libc = true,
        .imports = &.{.{ .name = library_name, .module = core }},
    });
    const executable = b.addExecutable(.{ .name = executable_name, .root_module = executable_module });
    b.installArtifact(executable);

    const c_module = b.createModule(.{
        .root_source_file = sourcePath(b, base, "src/c_api.zig"),
        .target = target,
        .optimize = optimize,
        .strip = optimize != .Debug,
        .link_libc = true,
        .imports = &.{.{ .name = library_name, .module = core }},
    });
    const c_library = b.addLibrary(.{ .name = library_name, .root_module = c_module, .linkage = .static });
    c_library.installHeader(sourcePath(b, base, "include/terminal_theme_tools.h"), "terminal_theme_tools.h");
    const install_c_library = b.addInstallArtifact(c_library, .{});
    if (builtin.os.tag == .macos and target.result.os.tag == .macos) {
        // Zig 0.16's Mach-O archive layout needs Apple's ranlib pass before ld64
        // accepts it from a non-Zig C toolchain.
        const ranlib = b.addSystemCommand(&.{
            "ranlib",
            b.getInstallPath(.lib, c_library.out_filename),
        });
        ranlib.step.dependOn(&install_c_library.step);
        b.getInstallStep().dependOn(&ranlib.step);
    } else {
        b.getInstallStep().dependOn(&install_c_library.step);
    }
    const c_shared_library = b.addLibrary(.{
        .name = library_name,
        .root_module = c_module,
        .linkage = .dynamic,
        .version = std.SemanticVersion.parse(version) catch unreachable,
    });
    if (builtin.os.tag == .macos and target.result.os.tag == .macos) {
        // Nixpkgs rewrites Mach-O install names after installation. Reserve
        // enough load-command space for the absolute Nix store path.
        c_shared_library.headerpad_max_install_names = true;
    }
    b.installArtifact(c_shared_library);

    const run_step = b.step("run", "Run terminal-theme-run");
    const run = b.addRunArtifact(executable);
    if (b.args) |args| run.addArgs(args);
    run_step.dependOn(&run.step);

    const test_step = b.step("test", "Run unit and integration tests");
    const unit_tests = b.addTest(.{ .root_module = core });
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);

    const version_test = b.addRunArtifact(executable);
    version_test.addArg("--version");
    version_test.expectStdOutEqual(executable_name ++ " version " ++ version ++ "\n");
    test_step.dependOn(&version_test.step);

    const print_theme_test = b.addRunArtifact(executable);
    print_theme_test.addArg("--print-theme");
    print_theme_test.setEnvironmentVariable("COLOR_SCHEME", "light");
    print_theme_test.expectStdOutEqual("light\n");
    test_step.dependOn(&print_theme_test.step);

    const print_theme_no_terminal_test = b.addRunArtifact(executable);
    print_theme_no_terminal_test.addArg("--print-theme-no-terminal");
    print_theme_no_terminal_test.setEnvironmentVariable("COLOR_SCHEME", "dark");
    print_theme_no_terminal_test.expectStdOutEqual("dark\n");
    test_step.dependOn(&print_theme_no_terminal_test.step);

    const help_test = b.addRunArtifact(executable);
    help_test.addArg("--help");
    help_test.expectStdOutMatch("Usage: " ++ executable_name);
    test_step.dependOn(&help_test.step);

    const no_command_test = b.addRunArtifact(executable);
    no_command_test.expectStdOutMatch("Usage: " ++ executable_name);
    test_step.dependOn(&no_command_test.step);

    const passthrough_test = b.addRunArtifact(executable);
    passthrough_test.addArgs(&.{ "sh", "-c", "exit 23" });
    passthrough_test.expectExitCode(23);
    test_step.dependOn(&passthrough_test.step);

    const missing_test = b.addRunArtifact(executable);
    missing_test.addArg("terminal-theme-run-command-that-does-not-exist");
    missing_test.expectExitCode(127);
    test_step.dependOn(&missing_test.step);

    const cannot_execute_test = b.addRunArtifact(executable);
    cannot_execute_test.addArg("/");
    cannot_execute_test.expectExitCode(126);
    test_step.dependOn(&cannot_execute_test.step);

    const separator_test = b.addRunArtifact(executable);
    separator_test.addArgs(&.{ "--", "sh", "-c", "exit 17" });
    separator_test.expectExitCode(17);
    test_step.dependOn(&separator_test.step);

    const help_command_test = b.addRunArtifact(executable);
    help_command_test.addArg("help");
    help_command_test.expectExitCode(127);
    test_step.dependOn(&help_command_test.step);

    const c_test_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
    c_test_module.addIncludePath(sourcePath(b, base, "include"));
    c_test_module.addCSourceFile(.{ .file = sourcePath(b, base, "tests/c_api_test.c"), .flags = c_api_flags });
    c_test_module.linkLibrary(c_library);
    const c_test = b.addExecutable(.{ .name = "c-api-test", .root_module = c_test_module });
    test_step.dependOn(&b.addRunArtifact(c_test).step);
}
