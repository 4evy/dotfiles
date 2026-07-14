package main

import (
	"context"
	"fmt"
	"os"

	"github.com/4evy/dotfiles/internal/common/cli"
	"github.com/4evy/dotfiles/internal/terminaltheme"
	"github.com/spf13/cobra"
)

var version = "dev"

func main() {
	code := 0
	cmd := &cobra.Command{
		Use:   "terminal-theme-run",
		Short: "Run terminal theme helpers",
	}
	for _, name := range terminaltheme.ConfiguredProgramNames() {
		program := name
		child := &cobra.Command{
			Use:                program + " [ARG...]",
			Short:              "Run " + program + " with terminal theme integration",
			DisableFlagParsing: true,
			RunE: func(_ *cobra.Command, args []string) error {
				var err error
				var ok bool
				code, ok, err = terminaltheme.RunConfigured(program, args)
				if err != nil || ok {
					return err
				}
				code = 1
				return fmt.Errorf("unknown program %q", program)
			},
		}
		cmd.AddCommand(child)
	}
	if err := cli.Execute(context.Background(), cmd, os.Args[1:], version); err != nil {
		os.Exit(1)
	}
	os.Exit(code)
}
