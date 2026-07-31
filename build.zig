const std = @import("std");
const project = @import("packages/terminal-theme-tools/build_support.zig");

pub fn build(b: *std.Build) void {
    project.configure(b, "packages/terminal-theme-tools");
}
