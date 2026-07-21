-- Copy selected or hovered files to the system clipboard.
--
-- Linux file managers disagree on clipboard metadata. The standard baseline is
-- text/uri-list; GNOME/Nautilus expects x-special/gnome-copied-files. macOS
-- uses AppKit file URLs so Finder sees files rather than a blob of path text.

local M = {}

---@class FlushableChild: Child
---@field flush fun(self: FlushableChild): boolean, Error?

M.title = "System Clipboard"
M.getenv = os.getenv

local state = ya.sync(function()
	-- Values returned by ya.sync must not contain Yazi userdata. Both `File` and
	-- `Url` are scoped userdata, so serialize them while the sync context is live.
	local paths = {}
	for _, file in pairs(cx.active.selected) do
		paths[#paths + 1] = tostring(file.url or file)
	end

	if #paths == 0 and cx.active.current.hovered then
		paths[1] = tostring(cx.active.current.hovered.url)
	end

	return paths
end)

function M.notify(level, content)
	ya.notify({
		title = M.title,
		content = content,
		level = level,
		timeout = 5,
	})
end

function M.has_arg(args, name)
	if args and (args[name] == true or args["--" .. name] == true) then
		return true
	end
	for _, arg in ipairs(args or {}) do
		if arg == name or arg == "--" .. name then
			return true
		end
	end
	return false
end

function M.env(name)
	return M.getenv(name) or ""
end

function M.desktop()
	return table
		.concat({
			M.env("XDG_CURRENT_DESKTOP"),
			M.env("XDG_SESSION_DESKTOP"),
			M.env("DESKTOP_SESSION"),
			M.env("KDE_FULL_SESSION"),
			M.env("GNOME_DESKTOP_SESSION_ID"),
		}, " ")
		:lower()
end

function M.desktop_matches(desktop, names)
	for _, name in ipairs(names) do
		if desktop:find(name, 1, true) then
			return true
		end
	end
	return false
end

function M.wayland_backend(args)
	if M.has_arg(args, "paths") or M.has_arg(args, "text") then
		return "paths"
	elseif
		M.has_arg(args, "uris")
		or M.has_arg(args, "uri-list")
		or M.has_arg(args, "kde")
		or M.has_arg(args, "standard")
	then
		return "uri-list"
	elseif M.has_arg(args, "gnome") or M.has_arg(args, "nautilus") or M.has_arg(args, "files") then
		return "gnome"
	end

	local desktop = M.desktop()
	if M.desktop_matches(desktop, { "gnome", "cinnamon", "mate", "pantheon", "budgie", "unity" }) then
		return "gnome"
	elseif M.desktop_matches(desktop, { "kde", "plasma", "lxqt" }) then
		return "uri-list"
	else
		return "uri-list"
	end
end

function M.percent_encode(path)
	return path:gsub("([^%w%-%._~%!%$%&%'%(%)%*%+%,%;%=%:%@/])", function(char)
		return string.format("%%%02X", string.byte(char))
	end)
end

function M.file_uri(path)
	return "file://" .. M.percent_encode(path)
end

function M.join(lines, separator)
	return table.concat(lines, separator or "\n") .. (separator or "\n")
end

function M.status_error(status, err)
	if err then
		return tostring(err)
	elseif status and status.code then
		return "exit status " .. tostring(status.code)
	else
		return "unknown error"
	end
end

function M.write_stdin(command, args, payload)
	local child, err = Command(command):arg(args or {}):stdin(Command.PIPED):spawn()

	if not child then
		return nil, err
	end
	---@cast child FlushableChild

	local ok, write_err = child:write_all(payload)
	if not ok then
		child:start_kill()
		return nil, write_err
	end

	ok, write_err = child:flush()
	if not ok then
		child:start_kill()
		return nil, write_err
	end

	ya.drop(child:take_stdin())
	return child:wait()
end

function M.copy_wayland_gnome(paths, operation)
	local payload = { operation or "copy" }
	for _, path in ipairs(paths) do
		payload[#payload + 1] = M.file_uri(path)
	end

	return M.write_stdin("wl-copy", { "--type", "x-special/gnome-copied-files" }, M.join(payload))
end

function M.copy_wayland_uri_list(paths)
	local payload = {}
	for _, path in ipairs(paths) do
		payload[#payload + 1] = M.file_uri(path)
	end

	return M.write_stdin("wl-copy", { "--type", "text/uri-list" }, M.join(payload, "\r\n"))
end

function M.copy_wayland_paths(paths)
	return M.write_stdin("wl-copy", { "--type", "text/plain;charset=utf-8" }, M.join(paths))
end

function M.copy_x11_gnome(paths, operation)
	local payload = { operation or "copy" }
	for _, path in ipairs(paths) do
		payload[#payload + 1] = M.file_uri(path)
	end

	return M.write_stdin(
		"xclip",
		{ "-selection", "clipboard", "-target", "x-special/gnome-copied-files" },
		M.join(payload)
	)
end

function M.copy_x11_uri_list(paths)
	local payload = {}
	for _, path in ipairs(paths) do
		payload[#payload + 1] = M.file_uri(path)
	end

	return M.write_stdin("xclip", { "-selection", "clipboard", "-target", "text/uri-list" }, M.join(payload, "\r\n"))
end

function M.copy_x11_paths(paths)
	return M.write_stdin("xclip", { "-selection", "clipboard", "-target", "UTF8_STRING" }, M.join(paths))
end

function M.copy_macos_files(paths)
	-- pbcopy only publishes text. AppKit's NSPasteboardWriting implementation for
	-- NSURL publishes one public.file-url item per path, which Finder can paste.
	local script = [[
ObjC.import("AppKit")
function run(argv) {
	if (argv.length === 0) {
		throw new Error("No file paths were provided")
	}
	const pasteboard = $.NSPasteboard.generalPasteboard
	const urls = $.NSMutableArray.alloc.init
	argv.forEach(path => urls.addObject($.NSURL.fileURLWithPath($(path))))
	pasteboard.clearContents
	if (!pasteboard.writeObjects(urls)) {
		throw new Error("Could not write file URLs to the pasteboard")
	}
	// NSURL provides its data lazily. Give the pasteboard server time to request
	// that promised data before this short-lived osascript process exits.
	$.NSThread.sleepForTimeInterval(0.1)
	return argv.length
}
]]

	return Command("osascript"):arg({ "-l", "JavaScript", "-e", script, "--" }):arg(paths):status()
end

function M.copy_macos_text(paths, uris)
	local payload = {}
	for _, path in ipairs(paths) do
		payload[#payload + 1] = uris and M.file_uri(path) or path
	end

	return M.write_stdin("pbcopy", {}, M.join(payload))
end

function M.success(status)
	return status and status.success
end

function M.copy_macos(paths, args)
	local text = M.has_arg(args, "paths") or M.has_arg(args, "text")
	local uris = M.has_arg(args, "uris") or M.has_arg(args, "uri-list")
	local status, err

	if text or uris then
		status, err = M.copy_macos_text(paths, uris)
		if M.success(status) then
			return status, uris and "pbcopy URI text" or "pbcopy path text"
		end
		return status, "pbcopy: " .. M.status_error(status, err)
	end

	status, err = M.copy_macos_files(paths)
	if M.success(status) then
		return status, "macOS file clipboard"
	end
	return status, "osascript: " .. M.status_error(status, err)
end

function M.copy_linux(paths, args)
	local backend = M.wayland_backend(args)
	local operation = M.has_arg(args, "cut") and "cut" or "copy"
	local attempts = {}

	local function attempt(label, fn)
		local status, err = fn()
		if M.success(status) then
			return status, label
		end
		attempts[#attempts + 1] = label .. ": " .. M.status_error(status, err)
	end

	local wayland = M.env("WAYLAND_DISPLAY") ~= ""
	local x11 = M.env("DISPLAY") ~= ""
	-- Try the active display protocol first. Trying both also handles XWayland and
	-- sparse environments where the session variables were not propagated.
	local protocols = wayland and { "wayland", "x11" } or { "x11", "wayland" }
	if not wayland and not x11 then
		protocols = { "wayland", "x11" }
	end

	for _, protocol in ipairs(protocols) do
		local status, label
		if protocol == "wayland" then
			if backend == "paths" then
				status, label = attempt("wl-copy path text", function()
					return M.copy_wayland_paths(paths)
				end)
			elseif backend == "gnome" then
				status, label = attempt("wl-copy GNOME files", function()
					return M.copy_wayland_gnome(paths, operation)
				end)
			else
				status, label = attempt("wl-copy URI list", function()
					return M.copy_wayland_uri_list(paths)
				end)
			end
		else
			if backend == "paths" then
				status, label = attempt("xclip path text", function()
					return M.copy_x11_paths(paths)
				end)
			elseif backend == "gnome" then
				status, label = attempt("xclip GNOME files", function()
					return M.copy_x11_gnome(paths, operation)
				end)
			else
				status, label = attempt("xclip URI list", function()
					return M.copy_x11_uri_list(paths)
				end)
			end
		end

		if status then
			return status, label
		end
	end

	return nil, table.concat(attempts, "; ")
end

function M.copy(paths, args)
	if ya.target_os() == "macos" then
		return M.copy_macos(paths, args)
	end

	return M.copy_linux(paths, args)
end

function M.entry(_, job)
	ya.emit("escape", { visual = true })

	local paths = state()
	if #paths == 0 then
		return M.notify("warn", "No file selected")
	end

	local status, backend = M.copy(paths, job and job.args or {})
	if not status or not status.success then
		return M.notify("error", "Could not copy files: " .. tostring(backend))
	end

	local noun = #paths == 1 and "file" or "files"
	M.notify("info", string.format("Copied %d %s with %s", #paths, noun, backend))
end

return M
