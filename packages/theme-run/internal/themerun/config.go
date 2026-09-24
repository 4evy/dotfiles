package themerun

import (
	"bytes"
	"cmp"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	validation "github.com/go-ozzo/ozzo-validation/v4"
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
		item.DisplayName = cmp.Or(item.DisplayName, item.Name)
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
	if err := validation.ValidateStruct(m,
		validation.Field(&m.Runtime),
		validation.Field(&m.Interpreters),
		validation.Field(&m.Integrations),
		validation.Field(&m.Runners),
	); err != nil {
		return err
	}
	m.aliases = make(map[string]string)
	for name, item := range m.Runners {
		for _, alias := range item.Aliases {
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

func containsPlaceholder(values []string, placeholder string) bool {
	return slices.ContainsFunc(values, func(value string) bool {
		return strings.Contains(value, placeholder)
	})
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
