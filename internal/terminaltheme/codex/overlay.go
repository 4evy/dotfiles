package codex

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/4evy/dotfiles/internal/common/envx"
)

type environment struct {
	Home string `env:"CODEX_HOME"`
}

func CreateTrustRuntimeForArgs(tuiTheme string, extraArgs []string) ([]string, []string, func(), error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, nil, nil, err
	}
	codexHome := resolveCodexHome(home)
	launchCwd, userProvidedCwd, err := resolveLaunchCwd(extraArgs)
	if err != nil {
		return nil, nil, nil, err
	}
	trustTargets := resolveTrustTargets(launchCwd)

	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		return nil, nil, nil, err
	}

	args := runtimeConfigArgs(trustTargets, launchCwd, userProvidedCwd, tuiTheme)
	args = append(args, extraArgs...)
	env := []string{
		"CODEX_HOME=" + codexHome,
		"CODEX_SQLITE_HOME=" + codexHome,
	}
	return env, args, func() {}, nil
}

func resolveCodexHome(home string) string {
	codexHome := filepath.Join(home, ".codex")
	if value := envx.MustParse[environment]().Home; value != "" {
		if value == "~" {
			value = home
		} else if rest, ok := strings.CutPrefix(value, "~/"); ok {
			value = filepath.Join(home, rest)
		}
		if !strings.HasPrefix(filepath.Base(value), "codex-trust") {
			codexHome = value
		}
	}
	return codexHome
}

func resolveLaunchCwd(args []string) (string, bool, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", false, err
	}
	if override, ok := cwdOverride(args); ok {
		if override == "~" {
			if home, err := os.UserHomeDir(); err == nil {
				override = home
			}
		} else if rest, ok := strings.CutPrefix(override, "~/"); ok {
			if home, err := os.UserHomeDir(); err == nil {
				override = filepath.Join(home, rest)
			}
		}
		if !filepath.IsAbs(override) {
			override = filepath.Join(cwd, override)
		}
		return filepath.Clean(override), true, nil
	}
	return cwd, false, nil
}

func cwdOverride(args []string) (string, bool) {
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			return "", false
		}
		switch {
		case arg == "-C" || arg == "--cd":
			if index+1 < len(args) {
				return args[index+1], true
			}
			return "", false
		case strings.HasPrefix(arg, "--cd="):
			return strings.TrimPrefix(arg, "--cd="), true
		case strings.HasPrefix(arg, "-C") && len(arg) > len("-C"):
			return strings.TrimPrefix(arg, "-C"), true
		}
	}
	return "", false
}

func resolveTrustTargets(cwd string) []string {
	targets := []string{cwd}
	output, err := exec.Command("git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err == nil && strings.TrimSpace(string(output)) != "" {
		targets = append(targets, strings.TrimSpace(string(output)))
	}
	return uniqueStrings(targets)
}

func uniqueStrings(items []string) []string {
	seen := make(map[string]bool, len(items))
	var out []string
	for _, item := range items {
		item = filepath.Clean(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func runtimeConfigArgs(trustTargets []string, launchCwd string, userProvidedCwd bool, tuiTheme string) []string {
	args := []string{
		"-c", "tui.theme=" + strconv.Quote(tuiTheme),
	}
	if !userProvidedCwd {
		args = append(args, "-C", launchCwd)
	}
	if len(trustTargets) > 0 {
		args = append(args, "-c", projectsTrustOverride(trustTargets))
	}
	return args
}

func projectsTrustOverride(trustTargets []string) string {
	var builder strings.Builder
	builder.WriteString("projects={")
	for index, trustTarget := range trustTargets {
		if index > 0 {
			builder.WriteString(",")
		}
		builder.WriteString(strconv.Quote(trustTarget))
		builder.WriteString("={trust_level=\"trusted\"}")
	}
	builder.WriteString("}")
	return builder.String()
}
