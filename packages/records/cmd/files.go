package main

import (
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/google/renameio/v2"
)

func parseJSONObject(path, label string) (map[string]jsontext.Value, error) {
	regular, err := isRegular(path)
	if err != nil {
		return nil, err
	}
	if !regular {
		return nil, fmt.Errorf("missing %s", label)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var result map[string]jsontext.Value
	if err := json.Unmarshal(content, &result); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON (%v)", label, err)
	}
	if result == nil {
		return nil, fmt.Errorf("%s must be an object", label)
	}
	return result, nil
}

func writePrivate(path string, content []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func replaceTextFile(path string, content []byte, mode os.FileMode) error {
	return renameio.WriteFile(path, content, mode.Perm(), renameio.IgnoreUmask())
}

func marshalJSON(value any) ([]byte, error) {
	return json.Marshal(value, json.Deterministic(true))
}

func marshalPrettyJSON(value any) ([]byte, error) {
	return json.Marshal(value, json.Deterministic(true), jsontext.WithIndent("  "))
}

func isRegular(path string) (bool, error) {
	return pathMatches(path, func(info os.FileInfo) bool {
		return info.Mode().IsRegular()
	})
}

func isDirectory(path string) (bool, error) {
	return pathMatches(path, os.FileInfo.IsDir)
}

func isExecutable(path string) (bool, error) {
	return pathMatches(path, func(info os.FileInfo) bool {
		return info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
	})
}

func pathExists(path string) (bool, error) {
	return pathMatches(path, func(os.FileInfo) bool { return true })
}

func pathMatches(path string, matches func(os.FileInfo) bool) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return matches(info), nil
}

func isWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && filepath.IsLocal(relative)
}

func relativePath(root, candidate string) (string, error) {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(relative), nil
}

func trimRightWhitespace(value string) string {
	return strings.TrimRightFunc(value, unicode.IsSpace)
}

func runCommand(name string, arguments ...string) ([]byte, error) {
	return commandOutput(exec.Command(name, arguments...))
}

func commandOutput(command *exec.Cmd) ([]byte, error) {
	stdout, err := command.Output()
	if err == nil {
		return stdout, nil
	}
	details := ""
	if exitError, ok := errors.AsType[*exec.ExitError](err); ok {
		details = strings.TrimSpace(string(exitError.Stderr))
	}
	if details == "" {
		details = strings.TrimSpace(string(stdout))
	}
	if details == "" {
		return nil, err
	}
	return nil, errors.New(details)
}
