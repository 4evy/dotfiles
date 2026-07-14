package terminaltheme

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/4evy/dotfiles/internal/common/envx"
	"github.com/4evy/dotfiles/internal/common/userdirs"
	"github.com/pelletier/go-toml/v2"
)

//go:embed runners.toml
var defaultRunnerConfig []byte

type manifestEnvironment struct {
	Config string `env:"TERMINAL_THEME_RUN_CONFIG"`
}

func ConfiguredProgramNames() []string {
	manifest, err := loadRunnerManifest()
	var names []string
	if err == nil {
		for _, runner := range manifest.Runners {
			names = append(names, runner.Name)
			names = append(names, runner.Aliases...)
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}

func RunConfigured(program string, extraArgs []string) (int, bool, error) {
	runner, ok, err := configuredRunner(program)
	if err != nil || !ok {
		return 1, ok, err
	}
	code, err := runner.run(extraArgs)
	return code, true, err
}

func configuredRunner(program string) (runnerSpec, bool, error) {
	manifest, err := loadRunnerManifest()
	if err != nil {
		return runnerSpec{}, false, err
	}
	for _, runner := range manifest.Runners {
		if runner.Name == program || slices.Contains(runner.Aliases, program) {
			return runner, true, nil
		}
	}
	return runnerSpec{}, false, nil
}

func loadRunnerManifest() (runnerManifest, error) {
	environment := envx.MustParse[manifestEnvironment]()
	var manifest runnerManifest
	if err := toml.Unmarshal(defaultRunnerConfig, &manifest); err != nil {
		return runnerManifest{}, err
	}
	var configPaths []string
	if environment.Config != "" {
		configPaths = filepath.SplitList(environment.Config)
	} else if home, err := HomeDir(); err == nil {
		configPaths = []string{
			filepath.Join(userdirs.ConfigHome(home), "terminal-theme-run/runners.toml"),
		}
	}
	for _, path := range configPaths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var override runnerManifest
		if err := toml.Unmarshal(data, &override); err != nil {
			return runnerManifest{}, fmt.Errorf("failed to parse %s: %w", path, err)
		}
		out := slices.Clone(manifest.Runners)
		for _, overrideRunner := range override.Runners {
			index := slices.IndexFunc(out, func(runner runnerSpec) bool {
				return runner.Name == overrideRunner.Name
			})
			if index >= 0 {
				out[index] = overrideRunner
				continue
			}
			out = append(out, overrideRunner)
		}
		manifest.Runners = out
	}
	return manifest, nil
}
