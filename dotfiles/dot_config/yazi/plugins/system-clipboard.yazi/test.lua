local plugin_path = arg[1] or "main.lua"
local calls, failures, notifications, emissions = {}, {}, {}, {}
local environment = {}
local target_os = "linux"

local original_command = rawget(_G, "Command")
local original_cx = rawget(_G, "cx")
local original_ya = rawget(_G, "ya")

local test_cx = {
	active = {
		selected = {},
		current = { hovered = { url = "/tmp/hovered file.txt" } },
	},
}

local test_ya = {
	sync = function(fn)
		return function(...)
			return fn(...)
		end
	end,
	target_os = function()
		return target_os
	end,
	emit = function(action, args)
		emissions[#emissions + 1] = { action = action, args = args }
	end,
	drop = function() end,
	notify = function(notification)
		notifications[#notifications + 1] = notification
	end,
}

local test_command = setmetatable({ PIPED = 1 }, {
	__call = function(_, program)
		local command = { program = program, args = {} }

		function command:arg(value)
			if type(value) == "table" then
				for _, item in ipairs(value) do
					self.args[#self.args + 1] = item
				end
			else
				self.args[#self.args + 1] = value
			end
			return self
		end

		function command:stdin()
			return self
		end

		function command:spawn()
			local call = { program = self.program, args = self.args }
			calls[#calls + 1] = call
			local child = {}

			function child.write_all(_, payload)
				call.payload = payload
				return true
			end

			function child.flush()
				return true
			end

			function child.take_stdin()
				return {}
			end

			function child.wait()
				local success = not failures[call.program]
				return { success = success, code = success and 0 or 1 }
			end

			function child.start_kill() end
			return child
		end

		function command:status()
			local call = { program = self.program, args = self.args }
			calls[#calls + 1] = call
			local success = not failures[call.program]
			return { success = success, code = success and 0 or 1 }
		end

		return command
	end,
})

rawset(_G, "cx", test_cx)
rawset(_G, "ya", test_ya)
rawset(_G, "Command", test_command)

local M = dofile(plugin_path)
M.getenv = function(name)
	return environment[name]
end

local function clear(values)
	for key in pairs(values) do
		values[key] = nil
	end
end

local function reset()
	clear(calls)
	clear(failures)
	clear(notifications)
	clear(emissions)
	clear(environment)
	target_os = "linux"
	test_cx.active.selected = {}
	test_cx.active.current.hovered = { url = "/tmp/hovered file.txt" }
end

local function contains(values, expected)
	for _, value in ipairs(values) do
		if value == expected then
			return true
		end
	end
	return false
end

local function assert_equal(actual, expected)
	if actual ~= expected then
		error(string.format("expected %q, got %q", tostring(expected), tostring(actual)), 2)
	end
end

local function assert_contains(values, expected)
	if not contains(values, expected) then
		error(string.format("expected list to contain %q", expected), 2)
	end
end

local test_count = 0
local function test(name, fn)
	reset()
	local ok, err = xpcall(fn, debug.traceback)
	if not ok then
		error(string.format("%s failed:\n%s", name, err), 0)
	end
	test_count = test_count + 1
end

local function run()
	test("arguments and URI encoding", function()
		assert(M.has_arg({ paths = true }, "paths"))
		assert(M.has_arg({ "--uris" }, "uris"))
		assert(not M.has_arg({}, "cut"))
		assert_equal(M.file_uri("/tmp/a b#c%?.txt"), "file:///tmp/a%20b%23c%25%3F.txt")
		assert_equal(M.file_uri("/tmp/café.txt"), "file:///tmp/caf%C3%A9.txt")
	end)

	test("Wayland GNOME cut payload", function()
		environment.WAYLAND_DISPLAY = "wayland-0"
		local status, label = M.copy_linux({ "/tmp/a b", "/tmp/c" }, { gnome = true, cut = true })
		assert(status.success)
		assert_equal(label, "wl-copy GNOME files")
		assert_equal(calls[1].program, "wl-copy")
		assert_contains(calls[1].args, "x-special/gnome-copied-files")
		assert_equal(calls[1].payload, "cut\nfile:///tmp/a%20b\nfile:///tmp/c\n")
	end)

	test("X11 KDE URI-list autodetection", function()
		environment.DISPLAY = ":0"
		environment.XDG_CURRENT_DESKTOP = "KDE"
		local status, label = M.copy_linux({ "/tmp/a b", "/tmp/c" }, {})
		assert(status.success)
		assert_equal(label, "xclip URI list")
		assert_equal(calls[1].program, "xclip")
		assert_contains(calls[1].args, "text/uri-list")
		assert_equal(calls[1].payload, "file:///tmp/a%20b\r\nfile:///tmp/c\r\n")
	end)

	test("plain path mode", function()
		environment.DISPLAY = ":0"
		local status, label = M.copy_linux({ "/tmp/a b", "/tmp/c" }, { paths = true })
		assert(status.success)
		assert_equal(label, "xclip path text")
		assert_contains(calls[1].args, "UTF8_STRING")
		assert_equal(calls[1].payload, "/tmp/a b\n/tmp/c\n")
	end)

	test("Wayland to X11 fallback", function()
		environment.WAYLAND_DISPLAY = "wayland-0"
		environment.DISPLAY = ":0"
		failures["wl-copy"] = true
		local status, label = M.copy_linux({ "/tmp/a" }, { gnome = true })
		assert(status.success)
		assert_equal(label, "xclip GNOME files")
		assert_equal(calls[1].program, "wl-copy")
		assert_equal(calls[2].program, "xclip")
		assert_contains(calls[2].args, "-target")
		assert_contains(calls[2].args, "x-special/gnome-copied-files")
		assert_equal(calls[2].payload, "copy\nfile:///tmp/a\n")
	end)

	test("Linux backend failure details", function()
		failures["wl-copy"] = true
		failures.xclip = true
		local status, details = M.copy_linux({ "/tmp/a" }, { uris = true })
		assert_equal(status, nil)
		assert(details:find("wl-copy URI list: exit status 1", 1, true))
		assert(details:find("xclip URI list: exit status 1", 1, true))
	end)

	test("macOS native file clipboard entry", function()
		target_os = "macos"
		test_cx.active.selected = {
			{ url = "/tmp/selected one.txt" },
			{ url = "/tmp/selected two.txt" },
		}
		M.entry(nil, { args = {} })
		assert_equal(emissions[1].action, "escape")
		assert_equal(emissions[1].args.visual, true)
		assert_equal(calls[1].program, "osascript")
		assert_contains(calls[1].args, "/tmp/selected one.txt")
		assert_contains(calls[1].args, "/tmp/selected two.txt")
		assert_contains(calls[1].args, "--")
		assert(calls[1].args[4]:find("NSThread.sleepForTimeInterval", 1, true))
		assert_equal(notifications[1].content, "Copied 2 files with macOS file clipboard")
	end)

	test("macOS URI text mode", function()
		local status, label = M.copy_macos({ "/tmp/a b", "/tmp/c" }, { uris = true })
		assert(status.success)
		assert_equal(label, "pbcopy URI text")
		assert_equal(calls[1].program, "pbcopy")
		assert_equal(calls[1].payload, "file:///tmp/a%20b\nfile:///tmp/c\n")
	end)

	test("hovered-file fallback", function()
		target_os = "macos"
		M.entry(nil, { args = {} })
		assert_contains(calls[1].args, "/tmp/hovered file.txt")
		assert_equal(notifications[1].content, "Copied 1 file with macOS file clipboard")
	end)

	test("empty selection warning", function()
		test_cx.active.current.hovered = nil
		M.entry(nil, { args = {} })
		assert_equal(#calls, 0)
		assert_equal(notifications[1].level, "warn")
		assert_equal(notifications[1].content, "No file selected")
	end)
end

local ok, err = xpcall(run, debug.traceback)
rawset(_G, "Command", original_command)
rawset(_G, "cx", original_cx)
rawset(_G, "ya", original_ya)
if not ok then
	error(err, 0)
end

print(string.format("system-clipboard.yazi: %d tests passed", test_count))
