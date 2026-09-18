package main

import (
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	command, err := newCommand(stdout, stderr)
	if err == nil {
		command.SetArgs(arguments)
		err = command.Execute()
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "records: error: %v\n", err)
		return 1
	}
	return 0
}

func newCommand(stdout, stderr io.Writer) (*cobra.Command, error) {
	vault, err := newVault(stdout, stderr)
	if err != nil {
		return nil, err
	}
	root := &cobra.Command{
		Use:           "records",
		Short:         "Manage encrypted dotfile records",
		Args:          cobra.NoArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(command *cobra.Command, _ []string) error {
			return command.Help()
		},
	}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.CompletionOptions.DisableDefaultCmd = true

	commands := []commandSpec{
		{
			use:   "unpack [directory]",
			short: "Materialize records or decrypt them into a protected workspace",
			args:  cobra.MaximumNArgs(1),
			run: func(arguments []string) error {
				if len(arguments) == 0 {
					return vault.unpackSource()
				}
				return vault.unpackWorkspace(arguments[0])
			},
		},
		{
			use:   "pack [directory]",
			short: "Re-encrypt materialized records or a protected workspace",
			args:  cobra.MaximumNArgs(1),
			run: func(arguments []string) error {
				if len(arguments) == 0 {
					return vault.packSource()
				}
				return vault.packWorkspace(arguments[0])
			},
		},
		{
			use:   "check [directory]",
			short: "Validate the vault, materialized records, or a protected workspace",
			args:  cobra.MaximumNArgs(1),
			run: func(arguments []string) error {
				return vault.check(optionalArgument(arguments))
			},
		},
		{
			use:   "edit [path]",
			short: "Materialize and edit the source tree or one record",
			args:  cobra.MaximumNArgs(1),
			run: func(arguments []string) error {
				return vault.editSource(optionalArgument(arguments))
			},
		},
		{
			use:   "layout",
			short: "Show target-to-source mappings and attributes",
			args:  cobra.NoArgs,
			run: func(_ []string) error {
				return vault.layout()
			},
		},
		{
			use:    "workspace-edit [collection [index]]",
			short:  "Edit records in a temporary protected workspace",
			hidden: true,
			args:   cobra.MaximumNArgs(2),
			run: func(arguments []string) error {
				collection := optionalArgument(arguments)
				index := ""
				if len(arguments) == 2 {
					index = arguments[1]
				}
				return vault.editWorkspace(collection, index)
			},
		},
	}
	for _, spec := range commands {
		root.AddCommand(spec.command())
	}
	return root, nil
}

type commandSpec struct {
	use    string
	short  string
	hidden bool
	args   cobra.PositionalArgs
	run    func([]string) error
}

func (spec commandSpec) command() *cobra.Command {
	return &cobra.Command{
		Use:    spec.use,
		Short:  spec.short,
		Hidden: spec.hidden,
		Args:   spec.args,
		RunE: func(_ *cobra.Command, arguments []string) error {
			return spec.run(arguments)
		},
	}
}

func optionalArgument(arguments []string) string {
	if len(arguments) == 0 {
		return ""
	}
	return arguments[0]
}
