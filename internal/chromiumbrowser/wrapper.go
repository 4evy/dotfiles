package chromiumbrowser

import (
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"

	"github.com/4evy/dotfiles/internal/common/fileutil"
	"github.com/buildkite/shellwords"
)

//go:embed scripts/wrapper.py
var wrapperScriptTemplate string

func writeWrapper(target, launcher string, options *InstallOptions) error {
	return WriteWrapper(target, launcher, options.Flags, options.extraWrapperFlags)
}

func WriteWrapper(target, launcher, flagsText string, extraFlags []string) error {
	var flags []string
	if flagsText != "" {
		var err error
		flags, err = shellwords.SplitPosix(flagsText)
		if err != nil {
			return err
		}
	}
	args := slices.Concat([]string{launcher}, flags, extraFlags)
	content := renderWrapperScript(args)
	return fileutil.WriteExecutable(target, []byte(content))
}

func renderWrapperScript(args []string) string {
	encoded, err := json.Marshal(args)
	if err != nil {
		panic(err)
	}
	return strings.ReplaceAll(wrapperScriptTemplate, "__COMMAND_JSON__", string(encoded))
}

func replaceSymlink(oldname, newname string) error {
	if err := os.Remove(newname); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Symlink(oldname, newname)
}
