package terminaltheme

type runnerManifest struct {
	Runners []runnerSpec `toml:"runner"`
}

type runnerSpec struct {
	Name        string         `toml:"name"`
	Aliases     []string       `toml:"aliases"`
	Programs    []string       `toml:"programs"`
	SkipEnv     []string       `toml:"skip_env"`
	DefaultArgs []string       `toml:"default_args"`
	Env         []string       `toml:"env"`
	EnvUnset    []string       `toml:"env_unset"`
	EnvOverlay  string         `toml:"env_overlay"`
	Config      *configSpec    `toml:"config"`
	ThemeArgs   []themeArgSpec `toml:"theme_arg"`
}

type configSpec struct {
	Format            string             `toml:"format"`
	DefaultPath       string             `toml:"default_path"`
	DefaultPathDarwin string             `toml:"default_path_darwin"`
	ArgNames          []string           `toml:"arg_names"`
	OutputArgs        []string           `toml:"output_args"`
	CacheSubdir       string             `toml:"cache_subdir"`
	TempPattern       string             `toml:"temp_pattern"`
	Updates           []configUpdateSpec `toml:"update"`
}

type configUpdateSpec struct {
	Path  string `toml:"path"`
	Dark  string `toml:"dark"`
	Light string `toml:"light"`
	Quote bool   `toml:"quote"`
}

type themeArgSpec struct {
	Dark  string `toml:"dark"`
	Light string `toml:"light"`
}
