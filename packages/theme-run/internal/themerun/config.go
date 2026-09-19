package themerun

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const (
	Name      = "theme-run"
	Version   = "0.1.0"
	ConfigEnv = "THEME_RUN_CONFIG"
	ActiveEnv = "THEME_RUN_ACTIVE"

	ExitSuccess       = 0
	ExitFailure       = 1
	ExitUsage         = 2
	ExitCannotExecute = 126
	ExitNotFound      = 127

	configDirectory        = Name
	configFile             = "config.toml"
	configDirectoryName    = ".config"
	cacheDirectoryName     = ".cache"
	maxFileBytes           = 1024 * 1024
	fileReadLimit          = maxFileBytes + 1
	runtimeLimitMin        = 1
	runtimeLimitMax        = 60_000
	quoteCharacterCount    = 1
	temporarySuffix        = "XXXXXX"
	defaultTemporaryPath   = "/tmp"
	defaultSearchPath      = "/usr/local/bin:/usr/bin:/bin"
	assignmentSeparator    = "="
	environmentReference   = "$"
	themePlaceholder       = "{theme}"
	contextPlaceholder     = "{context}"
	directoryPlaceholder   = "{directory}"
	homePlaceholder        = "{home}"
	terminalFallbackName   = "*"
	activeEnvironmentValue = "1"
	validQuoteCharacters   = "'\""
	invalidEnvNameBytes    = assignmentSeparator + "\x00"

	homeEnvironment       = "HOME"
	pathEnvironment       = "PATH"
	configHomeEnvironment = "XDG_CONFIG_HOME"
	cacheHomeEnvironment  = "XDG_CACHE_HOME"
	temporaryEnvironment  = "TMPDIR"
	terminalEnvironment   = "TERM"
)

//go:embed defaults.toml
var defaults []byte

type Theme string

const (
	Dark  Theme = "dark"
	Light Theme = "light"
)

type TerminalProtocol string

const (
	TerminalProtocolBackground  TerminalProtocol = "background"
	TerminalProtocolColorScheme TerminalProtocol = "color-scheme"
)

type IntegrationStrategy string

const (
	IntegrationStrategyArguments   IntegrationStrategy = "arguments"
	IntegrationStrategyConfig      IntegrationStrategy = "config"
	IntegrationStrategyEnvironment IntegrationStrategy = "environment"
)

type TemporaryLocation string

const (
	TemporaryLocationSystem TemporaryLocation = "system"
	TemporaryLocationCache  TemporaryLocation = "cache"
)

type ValidationFormat string

const ValidationTOML ValidationFormat = "toml"

type Variables map[string]string

type Platform struct {
	Commands [][]string `toml:"commands"`
	Fallback Theme      `toml:"fallback"`
}

type Priorities[K comparable] []K

func (priorities Priorities[K]) Lookup[V any, M ~map[K]V](values M) (V, bool) {
	for _, key := range priorities {
		if value, ok := values[key]; ok {
			return value, true
		}
	}
	var zero V
	return zero, false
}

func (priorities Priorities[K]) LookupFunc[V any, M ~map[K]V](values M, equal func(K, K) bool) (V, bool) {
	for _, key := range priorities {
		for candidate, value := range values {
			if equal(key, candidate) {
				return value, true
			}
		}
	}
	var zero V
	return zero, false
}

type Runtime struct {
	ThemeEnvironment                []string                    `toml:"theme_environment"`
	ThemeAliases                    map[Theme][]string          `toml:"theme_aliases"`
	ThemeTerminalProgramEnvironment string                      `toml:"theme_terminal_program_environment"`
	ThemeTerminalQueries            map[string]TerminalProtocol `toml:"theme_terminal_queries"`
	ThemePlatforms                  map[string]Platform         `toml:"theme_platforms"`
	ThemeProbeTimeoutMS             int                         `toml:"theme_probe_timeout_ms"`
	HelperTimeoutMS                 int                         `toml:"helper_timeout_ms"`
	HelperOutputLimitBytes          int                         `toml:"helper_output_limit_bytes"`
}

type Interpreter struct {
	Name             string   `toml:"name"`
	ShebangCommands  []string `toml:"shebang_commands"`
	ShebangArguments []string `toml:"shebang_arguments"`
	Programs         []string `toml:"programs"`
}

type Runner struct {
	Name        string    `toml:"name"`
	Aliases     []string  `toml:"aliases"`
	Programs    []string  `toml:"programs"`
	SkipEnv     []string  `toml:"skip_env"`
	DefaultArgs []string  `toml:"default_args"`
	Env         Variables `toml:"env"`
	EnvUnset    []string  `toml:"env_unset"`
	Integration string    `toml:"integration"`
	Interpreter string    `toml:"interpreter"`
}

type Integration struct {
	Name                     string              `toml:"name"`
	Strategy                 IntegrationStrategy `toml:"strategy"`
	DisplayName              string              `toml:"display_name"`
	DarkTheme                string              `toml:"dark_theme"`
	LightTheme               string              `toml:"light_theme"`
	Arguments                []string            `toml:"arguments"`
	Env                      Variables           `toml:"env"`
	ContextTable             string              `toml:"context_table"`
	ContextField             string              `toml:"context_field"`
	ContextValue             string              `toml:"context_value"`
	ContextPathFlags         []string            `toml:"context_path_flags"`
	ContextPathPrefixes      []string            `toml:"context_path_prefixes"`
	ContextArgumentSeparator string              `toml:"context_argument_separator"`
	ContextDirectoryCommands [][]string          `toml:"context_directory_commands"`
	DefaultConfig            string              `toml:"default_config"`
	Assignment               string              `toml:"assignment"`
	ConfigFlags              []string            `toml:"config_flags"`
	ConfigOutputFlag         string              `toml:"config_output_flag"`
	TemporaryPrefix          string              `toml:"temporary_prefix"`
	TemporaryLocation        TemporaryLocation   `toml:"temporary_location"`
	CacheSubdirectory        string              `toml:"cache_subdirectory"`
	Quote                    string              `toml:"quote"`
	Validation               ValidationFormat    `toml:"validation"`
}

type fragment struct {
	Runtime      *Runtime      `toml:"runtime"`
	Interpreters []Interpreter `toml:"interpreter"`
	Runners      []Runner      `toml:"runner"`
	Integrations []Integration `toml:"integration"`
}

type Manifest struct {
	Runtime      Runtime
	Runners      map[string]Runner
	Integrations map[string]Integration
	Interpreters map[string]Interpreter
	aliases      map[string]string
}

func Load(env Variables) (*Manifest, error) {
	manifest := newManifest()
	if err := manifest.loadFragment(defaults, "embedded defaults.toml"); err != nil {
		return nil, err
	}
	for _, path := range configPaths(env) {
		contents, err := readFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		if err := manifest.loadFragment(contents, path); err != nil {
			return nil, err
		}
	}
	if err := manifest.validate(); err != nil {
		return nil, err
	}
	return manifest, nil
}

func newManifest() *Manifest {
	return &Manifest{
		Runners:      make(map[string]Runner),
		Integrations: make(map[string]Integration),
		Interpreters: make(map[string]Interpreter),
		aliases:      make(map[string]string),
	}
}

func (m *Manifest) loadFragment(contents []byte, source string) error {
	var value fragment
	decoder := toml.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("parse %s: %w", source, err)
	}
	if value.Runtime != nil {
		m.Runtime = *value.Runtime
	}
	for _, item := range value.Interpreters {
		m.Interpreters[item.Name] = item
	}
	for _, item := range value.Runners {
		m.Runners[item.Name] = item
	}
	for _, item := range value.Integrations {
		if item.DisplayName == "" {
			item.DisplayName = item.Name
		}
		m.Integrations[item.Name] = item
	}
	return nil
}

func configPaths(env Variables) []string {
	if paths, ok := env[ConfigEnv]; ok {
		return slices.DeleteFunc(filepath.SplitList(paths), func(path string) bool {
			return path == ""
		})
	}
	if base := env[configHomeEnvironment]; base != "" {
		return []string{filepath.Join(base, configDirectory, configFile)}
	}
	if home := env[homeEnvironment]; home != "" {
		return []string{filepath.Join(home, configDirectoryName, configDirectory, configFile)}
	}
	return nil
}

func readFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	contents, err := io.ReadAll(io.LimitReader(file, fileReadLimit))
	if err != nil {
		return nil, err
	}
	if len(contents) > maxFileBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxFileBytes)
	}
	return contents, nil
}

func (m *Manifest) FindRunner(command string) (Runner, bool) {
	name := filepath.Base(command)
	if runner, ok := m.Runners[name]; ok {
		return runner, true
	}
	runnerName, ok := m.aliases[name]
	if !ok {
		return Runner{}, false
	}
	return m.Runners[runnerName], true
}

func (m *Manifest) validate() error {
	if err := validateRuntime(m.Runtime); err != nil {
		return err
	}
	m.aliases = make(map[string]string)
	for name, item := range m.Interpreters {
		if name == "" || len(item.ShebangCommands) == 0 || len(item.ShebangArguments) == 0 || len(item.Programs) == 0 || hasEmpty(item.ShebangCommands) || hasEmpty(item.ShebangArguments) || hasEmpty(item.Programs) {
			return fmt.Errorf("invalid interpreter %q", name)
		}
	}
	for name, item := range m.Integrations {
		if err := validateIntegration(item); err != nil {
			return fmt.Errorf("integration %q: %w", name, err)
		}
	}
	for name, item := range m.Runners {
		if name == "" {
			return errors.New("runner name must not be empty")
		}
		for _, value := range slices.Concat(item.SkipEnv, item.EnvUnset) {
			if !validEnvName(value) {
				return fmt.Errorf("runner %q has invalid environment name %q", name, value)
			}
		}
		for key := range item.Env {
			if !validEnvName(key) {
				return fmt.Errorf("runner %q has invalid environment name %q", name, key)
			}
		}
		if slices.Contains(item.Programs, environmentReference) {
			return fmt.Errorf("runner %q has invalid program reference", name)
		}
		for _, alias := range item.Aliases {
			if alias == "" {
				return fmt.Errorf("runner %q has an empty alias", name)
			}
			if _, exists := m.Runners[alias]; exists {
				return fmt.Errorf("runner alias %q collides with a runner", alias)
			}
			if _, exists := m.aliases[alias]; exists {
				return fmt.Errorf("duplicate runner alias %q", alias)
			}
			m.aliases[alias] = name
		}
		if item.Integration != "" {
			if _, ok := m.Integrations[item.Integration]; !ok {
				return fmt.Errorf("runner %q references missing integration %q", name, item.Integration)
			}
		}
		if item.Interpreter != "" {
			if _, ok := m.Interpreters[item.Interpreter]; !ok {
				return fmt.Errorf("runner %q references missing interpreter %q", name, item.Interpreter)
			}
		}
	}
	return nil
}

func validateRuntime(value Runtime) error {
	if len(value.ThemeEnvironment) == 0 || value.ThemeTerminalProgramEnvironment == "" {
		return errors.New("runtime theme detection policy is incomplete")
	}
	for _, theme := range themePriorities {
		aliases := value.ThemeAliases[theme]
		if len(aliases) == 0 || hasEmpty(aliases) {
			return fmt.Errorf("runtime aliases for %s must not be empty", theme)
		}
	}
	for theme := range value.ThemeAliases {
		if !validTheme(theme) {
			return fmt.Errorf("runtime aliases contain invalid theme %q", theme)
		}
	}
	for name, protocol := range value.ThemeTerminalQueries {
		if protocol != TerminalProtocolBackground && protocol != TerminalProtocolColorScheme {
			return fmt.Errorf("invalid terminal protocol %q for %q", protocol, name)
		}
	}
	if _, ok := value.ThemeTerminalQueries[terminalFallbackName]; !ok {
		return errors.New("runtime terminal query fallback is missing")
	}
	if _, ok := value.ThemePlatforms[terminalFallbackName]; !ok {
		return errors.New("runtime platform fallback is missing")
	}
	for name, platform := range value.ThemePlatforms {
		if name == "" {
			return errors.New("runtime platform name must not be empty")
		}
		if !validTheme(platform.Fallback) {
			return fmt.Errorf("runtime platform %q fallback must be %s or %s", name, Dark, Light)
		}
		if err := validateCommands(platform.Commands); err != nil {
			return fmt.Errorf("runtime platform %q: %w", name, err)
		}
	}
	limits := []int{value.ThemeProbeTimeoutMS, value.HelperTimeoutMS}
	for _, limit := range limits {
		if limit < runtimeLimitMin || limit > runtimeLimitMax {
			return fmt.Errorf("runtime timeout must be between %d and %d ms", runtimeLimitMin, runtimeLimitMax)
		}
	}
	if value.HelperOutputLimitBytes < runtimeLimitMin || value.HelperOutputLimitBytes > maxFileBytes {
		return fmt.Errorf("runtime helper output limit must be between %d and %d bytes", runtimeLimitMin, maxFileBytes)
	}
	return nil
}

func validateIntegration(value Integration) error {
	if value.Name == "" || value.DarkTheme == "" || value.LightTheme == "" {
		return errors.New("name and theme values must not be empty")
	}
	for key := range value.Env {
		if !validEnvName(key) {
			return fmt.Errorf("invalid environment name %q", key)
		}
	}
	switch value.Strategy {
	case IntegrationStrategyArguments:
		if len(value.Arguments) == 0 || !containsPlaceholder(value.Arguments, themePlaceholder) {
			return fmt.Errorf("argument strategy must use %s", themePlaceholder)
		}
		contextFields := []string{value.ContextTable, value.ContextField, value.ContextValue}
		usesContext := slices.ContainsFunc(contextFields, func(field string) bool {
			return field != ""
		})
		if usesContext && (hasEmpty(contextFields) || !containsPlaceholder(value.Arguments, contextPlaceholder)) {
			return errors.New("directory context policy is incomplete")
		}
		for _, command := range value.ContextDirectoryCommands {
			if len(command) == 0 || !containsPlaceholder(command, directoryPlaceholder) {
				return fmt.Errorf("directory context command must use %s", directoryPlaceholder)
			}
		}
	case IntegrationStrategyConfig:
		if value.DefaultConfig == "" || value.Assignment == "" || len(value.ConfigFlags) == 0 || value.ConfigOutputFlag == "" || value.TemporaryPrefix == "" || value.TemporaryLocation == "" || len(value.Quote) != quoteCharacterCount || !strings.Contains(validQuoteCharacters, value.Quote) {
			return errors.New("config strategy is incomplete")
		}
		if !strings.HasSuffix(value.TemporaryPrefix, temporarySuffix) || filepath.Base(value.TemporaryPrefix) != value.TemporaryPrefix {
			return fmt.Errorf("temporary prefix must be a basename ending in %s", temporarySuffix)
		}
		if value.TemporaryLocation != TemporaryLocationSystem && value.TemporaryLocation != TemporaryLocationCache {
			return fmt.Errorf("temporary location must be %s or %s", TemporaryLocationSystem, TemporaryLocationCache)
		}
		if value.TemporaryLocation == TemporaryLocationCache && value.CacheSubdirectory == "" {
			return errors.New("cache temporary files need a cache subdirectory")
		}
		if value.Validation != "" && value.Validation != ValidationTOML {
			return fmt.Errorf("validation must be %s", ValidationTOML)
		}
	case IntegrationStrategyEnvironment:
		if len(value.Env) == 0 {
			return errors.New("environment strategy needs variables")
		}
		found := false
		for _, contents := range value.Env {
			found = found || strings.Contains(contents, themePlaceholder)
		}
		if !found {
			return fmt.Errorf("environment strategy must use %s", themePlaceholder)
		}
	default:
		return fmt.Errorf("unsupported strategy %q", value.Strategy)
	}
	return nil
}

func validateCommands(commands [][]string) error {
	for _, command := range commands {
		if len(command) == 0 || hasEmpty(command) {
			return errors.New("runtime helper commands must not be empty")
		}
	}
	return nil
}

func validTheme(value Theme) bool { return slices.Contains(themePriorities, value) }

func validEnvName(value string) bool {
	return value != "" && !strings.ContainsAny(value, invalidEnvNameBytes)
}

func containsPlaceholder(values []string, placeholder string) bool {
	for _, value := range values {
		if strings.Contains(value, placeholder) {
			return true
		}
	}
	return false
}

func hasEmpty(values []string) bool {
	return slices.Contains(values, "")
}

func CurrentEnvironment() Variables {
	result := make(Variables)
	for _, assignment := range os.Environ() {
		key, value, _ := strings.Cut(assignment, assignmentSeparator)
		result[key] = value
	}
	return result
}

func PlatformCommands(value Runtime) ([][]string, Theme) {
	platform, _ := (Priorities[string]{runtime.GOOS, terminalFallbackName}).Lookup(value.ThemePlatforms)
	return platform.Commands, platform.Fallback
}
