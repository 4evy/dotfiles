package zellijtheme

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/4evy/dotfiles/internal/common/envx"
)

type zellijEnvironment struct {
	UID    string `env:"UID"`
	Active string `env:"ZELLIJ"`
	PaneID string `env:"ZELLIJ_PANE_ID"`
}

func RunZellij(extraArgs []string) (int, error) {
	environment := envx.MustParse[zellijEnvironment]()
	uid := environment.UID
	digits := uid != ""
	for _, ch := range uid {
		if ch < '0' || ch > '9' {
			digits = false
			break
		}
	}
	if !digits {
		output, err := exec.Command("id", "-u").Output()
		if err == nil {
			uid = strings.TrimSpace(string(output))
		}
		if uid == "" {
			uid = "0"
		}
	}
	socketDir := filepath.Join(os.TempDir(), "zellij-"+uid)
	if err := os.MkdirAll(socketDir, 0o755); err != nil {
		return 1, err
	}
	var args []string
	runner, ok, err := configuredRunner("zellij")
	if err == nil && ok {
		args = slices.Clone(runner.DefaultArgs)
	} else {
		args = []string{
			"options",
			"--default-layout",
			"compact",
			"--attach-to-session",
			"false",
			"--mirror-session",
			"false",
			"--on-force-close",
			"detach",
		}
	}
	theme := DetectSystemTheme()
	args = appendThemeOptions(args, extraArgs, theme)
	args = append(args, extraArgs...)
	return RunInheritEnv(
		"zellij",
		args,
		append(os.Environ(), "ZELLIJ_SOCKET_DIR="+socketDir, "ZELLIJ_THEME_RUN_THEME="+theme.Name),
	)
}

func appendThemeOptions(args, extraArgs []string, theme Theme) []string {
	if !hasZellijOption(args, "--theme") && !hasZellijOption(extraArgs, "--theme") {
		args = append(args, "--theme", theme.Name)
	}
	if !hasZellijOption(args, "--theme-dark") && !hasZellijOption(extraArgs, "--theme-dark") {
		args = append(args, "--theme-dark", Frappe.Name)
	}
	if !hasZellijOption(args, "--theme-light") && !hasZellijOption(extraArgs, "--theme-light") {
		args = append(args, "--theme-light", Latte.Name)
	}
	return args
}

func hasZellijOption(args []string, name string) bool {
	for index, arg := range args {
		if arg == "--" {
			return false
		}
		if arg == name {
			return true
		}
		if strings.HasPrefix(arg, name+"=") {
			return true
		}
		if arg == "options" && index == 0 {
			continue
		}
	}
	return false
}

type StartupPaneColor struct {
	enabled bool
}

func StartStartupPaneColor(theme Theme) StartupPaneColor {
	environment := envx.MustParse[zellijEnvironment]()
	_, err := exec.LookPath("zellij")
	enabled := environment.Active != "" && err == nil
	if enabled {
		// Important: keep Codex startup tinting scoped to zellij's pane color.
		// Do not use OSC 10/11 here: those mutate Ghostty's terminal palette
		// directly, and after Codex exits Ghostty can keep rendering the old
		// background until the pane is manually cleared or repainted.
		RunSilent("zellij", "action", "set-pane-color", "--fg", theme.Colors.FG, "--bg", theme.Colors.BG)

		go func() {
			time.Sleep(3 * time.Second)
			RunSilent("zellij", "action", "set-pane-color", "--reset")
		}()
	}
	return StartupPaneColor{enabled: enabled}
}

func (s StartupPaneColor) Close() {
	if s.enabled {
		RunSilent("zellij", "action", "set-pane-color", "--reset")
	}
}
