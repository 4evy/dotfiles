local function setup_plugin(name, opts)
	local ok, plugin = pcall(require, name)
	if ok and type(plugin.setup) == "function" then
		if opts == nil then
			plugin:setup()
		else
			plugin:setup(opts)
		end
	end
end

setup_plugin("full-border")
setup_plugin("git", { order = 1500 })
setup_plugin("starship")
