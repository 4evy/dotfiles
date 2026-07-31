const std = @import("std");
const project = @import("build_support.zig");

pub fn build(b: *std.Build) void {
    project.configure(b, ".");
}
