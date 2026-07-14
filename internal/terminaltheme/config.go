package terminaltheme

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/4evy/dotfiles/internal/common/userdirs"
	"github.com/pelletier/go-toml/v2"
)

func (c configSpec) args(extraArgs []string, theme Theme) ([]string, func(), error) {
	basePath := ""
	for index := 0; index < len(extraArgs); index++ {
		arg := extraArgs[index]
		for _, name := range c.ArgNames {
			if arg == name {
				if index+1 < len(extraArgs) {
					basePath = extraArgs[index+1]
				}
				break
			}
			if value, ok := strings.CutPrefix(arg, name+"="); ok {
				basePath = value
				break
			}
		}
		if basePath != "" {
			break
		}
	}
	if basePath == "" {
		if runtime.GOOS == "darwin" && c.DefaultPathDarwin != "" {
			basePath = c.DefaultPathDarwin
		} else {
			basePath = c.DefaultPath
		}
	}
	basePath = expandPath(basePath)
	configText := ""
	if data, err := os.ReadFile(basePath); err == nil {
		configText = string(data)
	}
	var patched string
	switch c.Format {
	case "toml":
		doc := map[string]any{}
		if strings.TrimSpace(configText) != "" {
			if err := toml.Unmarshal([]byte(configText), &doc); err != nil {
				return nil, nil, err
			}
		}
		for _, update := range c.Updates {
			value := update.Dark
			if theme.Name == Latte.Name {
				value = update.Light
			}
			setNestedValue(doc, strings.Split(update.Path, "."), value)
		}
		out, err := toml.Marshal(doc)
		if err != nil {
			return nil, nil, err
		}
		patched = string(out)
	case "ini", "key-value":
		var err error
		patched, err = patchINI(configText, c.Updates, theme)
		if err != nil {
			return nil, nil, err
		}
	case "kdl":
		var err error
		patched, err = patchKDL(configText, c.Updates, theme)
		if err != nil {
			return nil, nil, err
		}
	default:
		return nil, nil, fmt.Errorf("unsupported config format %q", c.Format)
	}
	cache := os.TempDir()
	if c.CacheSubdir != "" {
		cache = filepath.Join(userdirs.CacheHome(""), c.CacheSubdir)
	}
	if err := os.MkdirAll(cache, 0o755); err != nil {
		return nil, nil, err
	}
	pattern := c.TempPattern
	if pattern == "" {
		pattern = "terminal-theme-run-*"
	}
	file, err := os.CreateTemp(cache, pattern)
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.Remove(file.Name()) }
	if _, err := file.WriteString(patched); err != nil {
		file.Close()
		cleanup()
		return nil, nil, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return nil, nil, err
	}
	outputArgs := c.OutputArgs
	if len(outputArgs) == 0 && len(c.ArgNames) > 0 {
		outputArgs = []string{c.ArgNames[0]}
	}
	out := slices.Clone(outputArgs)
	out = append(out, file.Name())
	return out, cleanup, nil
}
