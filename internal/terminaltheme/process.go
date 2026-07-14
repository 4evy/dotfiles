package terminaltheme

import (
	"errors"
	"os"
	"os/exec"
)

func RunInheritEnv(program string, args []string, env []string) (int, error) {
	cmd := exec.Command(program, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if len(env) > 0 {
		cmd.Env = env
	}
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
		return exitErr.ExitCode(), nil
	}
	return 1, err
}

func RunSilent(program string, args ...string) {
	cmd := exec.Command(program, args...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	_ = cmd.Run()
}
