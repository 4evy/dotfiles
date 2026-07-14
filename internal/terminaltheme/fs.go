package terminaltheme

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func HomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("HOME is not set")
	}
	return home, nil
}

func expandPath(path string) string {
	if path == "" {
		return ""
	}
	home, err := HomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		return filepath.Join(home, rest)
	}
	return path
}
