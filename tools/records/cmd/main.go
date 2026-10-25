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

	deploy := &cobra.Command{
		Use:   "deploy",
		Short: "Decrypt records into protected runtime files for Hjem",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			directory, _ := command.Flags().GetString("directory")
			return vault.deploy(directory)
		},
	}
	deploy.Flags().String("directory", "", "Protected runtime root (defaults to XDG_STATE_HOME/hjem/records)")
	root.AddCommand(deploy)
	root.AddCommand(
		&cobra.Command{
			Use:   "unpack [directory]",
			Short: "Materialize records or decrypt them into a protected workspace",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(_ *cobra.Command, arguments []string) error {
				if len(arguments) == 0 {
					return vault.unpackSource()
				}
				return vault.unpackWorkspace(arguments[0])
			},
		},
		&cobra.Command{
			Use:   "pack [directory]",
			Short: "Re-encrypt materialized records or a protected workspace",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(_ *cobra.Command, arguments []string) error {
				if len(arguments) == 0 {
					return vault.packSource()
				}
				return vault.packWorkspace(arguments[0])
			},
		},
		&cobra.Command{
			Use:   "check [directory]",
			Short: "Validate the vault, materialized records, or a protected workspace",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(_ *cobra.Command, arguments []string) error {
				return vault.check(optionalArgument(arguments))
			},
		},
		&cobra.Command{
			Use:   "edit [path]",
			Short: "Materialize and edit the source tree or one record",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(_ *cobra.Command, arguments []string) error {
				return vault.editSource(optionalArgument(arguments))
			},
		},
		&cobra.Command{
			Use:   "layout",
			Short: "Show target-to-source mappings and attributes",
			Args:  cobra.NoArgs,
			RunE: func(_ *cobra.Command, _ []string) error {
				return vault.layout()
			},
		},
		&cobra.Command{
			Use:    "workspace-edit [collection [index]]",
			Short:  "Edit records in a temporary protected workspace",
			Hidden: true,
			Args:   cobra.MaximumNArgs(2),
			RunE: func(_ *cobra.Command, arguments []string) error {
				collection := optionalArgument(arguments)
				index := ""
				if len(arguments) == 2 {
					index = arguments[1]
				}
				return vault.editWorkspace(collection, index)
			},
		},
	)
	return root, nil
}

func optionalArgument(arguments []string) string {
	if len(arguments) == 0 {
		return ""
	}
	return arguments[0]
}
