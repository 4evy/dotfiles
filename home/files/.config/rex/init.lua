local scrollback = require("scrollback")

rex.action({
	name = "edit_scrollback",
	title = "Edit Scrollback in Helix",
	category = "Pane",
	run = scrollback.open,
})

rex.action({
	name = "ignore_key",
	title = "Ignore Key",
	run = function() end,
})

local profiles = {
	{ primary = "cmd", secondary = "shift+cmd", tabs = "alt+cmd" },
	{ primary = "ctrl", secondary = "ctrl+shift", tabs = "ctrl+alt" },
}
local directions = { "left", "right", "up", "down" }
local secondary_actions = {
	{ "backspace", "pane.close" },
	{ "t", "client.tab.new" },
	{ "n", "client.window.new" },
}
local tab_navigation = {
	{ "left", "client.tab.previous" },
	{ "right", "client.tab.next" },
}
local prefix_actions = {
	{ "t", "client.tab.new" },
	{ "s>e", "edit_scrollback" },
}

-- Exceptions and aliases that differ between the Cmd and Ctrl profiles
local bindings = {
	{ "cmd+k", "com.superlogical.terminal.clear" },
	{ "shift+cmd+k", "session.switch" },
	{ { "ctrl+shift+delete", "ctrl+shift+w" }, "client.tab.close" },
	{ "ctrl+shift+p", "client.palette.toggle" },
	{ "ctrl+pageup", "client.tab.previous" },
	{ "ctrl+pagedown", "client.tab.next" },
	{ "ctrl+enter", "client.window.fullscreen.toggle" },
	{ { "ctrl+=", "ctrl+shift+=" }, "client.font.increase" },
	{ { "shift+cmd+-", "ctrl+-", "ctrl+shift+-" }, "client.font.decrease" },
}

-- Queue in OMP/Codex and preserve Ghostty's terminal navigation
local forwarded_keys = {
	{ "cmd+c", "ctrl+c" },
	{ { "cmd+enter", "ctrl+shift+enter" }, "ctrl+shift+enter" },
	{ { "cmd+left", "ctrl+left" }, "home" },
	{ { "cmd+right", "ctrl+right" }, "end" },
	{ "alt+left", "alt+b" },
	{ "alt+right", "alt+f" },
}

local function bind(keys, action, args)
	for _, key in ipairs(type(keys) == "table" and keys or { keys }) do
		rex.bind(key, action, args)
	end
end

local function pass_through(prefix)
	bind(prefix .. ">" .. prefix, "pane.send_key", { key = prefix })
end

for _, binding in ipairs(bindings) do
	bind(unpack(binding))
end
for _, binding in ipairs(forwarded_keys) do
	bind(binding[1], "pane.send_key", { key = binding[2] })
end

for _, profile in ipairs(profiles) do
	for index = 1, 9 do
		bind(profile.primary .. "+" .. index, "client.tab.goto", { index = index })
	end
	bind(profile.primary .. "+0", "client.font.reset")
	bind(profile.primary .. "+,", "client.config.reload")
	bind(profile.primary .. "+t", "ignore_key")

	for _, binding in ipairs(secondary_actions) do
		bind(profile.secondary .. "+" .. binding[1], binding[2])
	end
	for _, binding in ipairs(tab_navigation) do
		bind(profile.tabs .. "+" .. binding[1], binding[2])
	end
	for _, direction in ipairs(directions) do
		bind(profile.secondary .. "+" .. direction, "pane.focus", { direction = direction })
		bind(profile.secondary .. "+s>" .. direction, "pane.split", { direction = direction })
	end

	pass_through(profile.secondary .. "+s")
	pass_through(profile.primary .. "+g")
	for _, binding in ipairs(prefix_actions) do
		bind(profile.primary .. "+g>" .. binding[1], binding[2])
	end
end
