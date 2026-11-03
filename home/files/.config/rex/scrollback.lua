local M = {}
local module_path = debug.getinfo(1, "S").source:gsub("^@", "")
local chunk_bytes = 900000
local terminal = "com.superlogical.terminal"
local export_options = {
	format = "text",
	trim = true,
	unwrap = true,
	max_bytes = chunk_bytes,
}

local function block_rect(node, block_id)
	if not node then
		return nil
	end
	if node.block_id == block_id then
		return node.rect
	end
	if node.split then
		return block_rect(node.split.before, block_id) or block_rect(node.split.after, block_id)
	end
end

local function placement(block_id)
	local view = assert(rex.session.view({}))
	for _, window in ipairs(view.windows or {}) do
		for _, layer in ipairs(window.layers or {}) do
			local rect = block_rect(layer.layout, block_id)
			if rect then
				return {
					window_id = window.window_id,
					bounds = window.zoomed_block_id == block_id and { 0, 0, 1, 1 } or rect,
				}
			end
		end
	end
	error("The terminal is no longer in a window", 0)
end

local function write_snapshot(file, snapshot)
	local chunk = { data = snapshot.content, eof = not snapshot.id }
	local offset = 0
	while true do
		assert(file:write(chunk.data))
		offset = offset + #chunk.data
		if chunk.eof then
			return
		end
		chunk = assert(rex.block.call(terminal, "blob_read", {
			id = snapshot.id,
			offset = offset,
			max_bytes = chunk_bytes,
		}))
		assert(chunk.eof or #chunk.data > 0, "Scrollback export stopped before reaching the end")
	end
end

function M.open(ctx)
	assert(ctx.block_id, "Focus a terminal before opening its scrollback")
	local layer = placement(ctx.block_id)
	local snapshot = assert(rex.block.call(terminal, "format", export_options))
	local temporary = assert(rex.exec({
		"/usr/bin/mktemp",
		"-d",
		(os.getenv("TMPDIR") or "/tmp") .. "/rex-scrollback.XXXXXX",
	}))
	assert(temporary.ok, temporary.stderr)
	local directory = temporary.stdout:gsub("%s+$", "")
	local path = directory .. "/scrollback.txt"
	local file
	local ok, result = pcall(function()
		file = assert(io.open(path, "wb"))
		write_snapshot(file, snapshot)
		assert(file:close())
		file = nil

		local process = rex.block.call(terminal, "process", {})
		local foreground = process and (process.foreground or process.child)
		-- A floating layer preserves the terminal and its split layout underneath
		layer.focus = true
		layer.layout = rex.layout.block({
			flavor = terminal .. ".shell",
			label = "Scrollback",
			options = {
				shell = "none",
				login = false,
				cwd = foreground and foreground.cwd,
				command = {
					"/bin/zsh",
					os.getenv("HOME") .. "/.local/lib/rex/scrollback.zsh",
					path,
					ctx.block_id,
					module_path,
				},
			},
		})
		return assert(rex.session.new_layer(layer))
	end)
	if not ok then
		if file then
			file:close()
		end
		os.remove(path)
		rex.exec({ "/bin/rmdir", directory })
		error(result, 0)
	end
	return result
end

function M.restore_focus(args)
	-- The editor, its source, or the whole session may already have closed
	if not rex.session.attach({ session_id = args.session }) then
		return
	end
	local view = rex.session.view({ session_id = args.session })
	if not view then
		return
	end
	local source = rex.session.describe_block({ session_id = args.session, block_id = args.source })
	if not source or source.block.placement ~= "placed" then
		return
	end
	for _, window in ipairs(view.windows or {}) do
		if window.window_id == view.active_window_id and window.focused_block_id == args.editor then
			rex.session.focus_block({ session_id = args.session, block_id = args.source })
			return
		end
	end
end

-- The exit handler runs this file as a script instead of loading a module
if rex.args and rex.args.restore_focus then
	M.restore_focus(rex.args)
	return
end

return M
