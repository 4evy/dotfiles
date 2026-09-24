package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/4evy/dotfiles/packages/theme-run/internal/themerun"
	"github.com/alecthomas/kong"
)

const (
	argumentDelimiter = "--"
	versionVariable   = "version"
)

type CLI struct {
	PrintTheme           bool             `help:"Print the detected terminal theme (dark or light)." xor:"theme"`
	PrintThemeNoTerminal bool             `help:"Print the theme without reading terminal input." xor:"theme"`
	Version              kong.VersionFlag `help:"Show program version."`
	Command              []string         `arg:"" optional:"" passthrough:"partial" metavar:"COMMAND [ARG...]"`
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cli := CLI{}
	parser := kong.Must(
		&cli,
		kong.Name(themerun.Name),
		kong.Description("Run a command with terminal theme integration when a matching profile exists."),
		kong.Vars{versionVariable: fmt.Sprintf("%s version %s", themerun.Name, themerun.Version)},
		kong.Writers(os.Stdout, os.Stderr),
	)
	context, err := parser.Parse(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", themerun.Name, err)
		return themerun.ExitUsage
	}
	printTheme := cli.PrintTheme || cli.PrintThemeNoTerminal
	if printTheme && len(cli.Command) != 0 {
		fmt.Fprintf(os.Stderr, "%s: theme printing does not accept a command\n", themerun.Name)
		return themerun.ExitUsage
	}
	command := cli.Command
	if len(command) != 0 && command[0] == argumentDelimiter {
		command = command[1:]
	}
	if !printTheme && len(command) == 0 {
		_ = context.PrintUsage(false)
		return themerun.ExitSuccess
	}

	env := themerun.CurrentEnvironment()
	manifest, err := themerun.Load(env)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: failed to load configuration: %v\n", themerun.Name, err)
		return themerun.ExitFailure
	}
	if printTheme {
		fmt.Println(themerun.Detect(manifest.Runtime, env, cli.PrintTheme))
		return themerun.ExitSuccess
	}
	runner, matched := manifest.FindRunner(command[0])
	if !matched {
		status, _ := themerun.ExecUnknown(command)
		return status
	}
	invocation, err := themerun.PrepareInvocation(manifest, runner, command[0], command[1:], env, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: failed to run %s: %v\n", themerun.Name, command[0], err)
		if errors.Is(err, os.ErrNotExist) {
			return themerun.ExitNotFound
		}
		return themerun.ExitCannotExecute
	}
	defer invocation.Cleanup()
	status, err := invocation.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: failed to run %s: %v\n", themerun.Name, command[0], err)
	}
	return status
}
