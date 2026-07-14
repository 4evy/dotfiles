package terminaltheme

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func detectTerminalTheme(timeout time.Duration) (TerminalThemeMode, bool) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return Dark, false
	}
	defer tty.Close()

	state, err := sttyOutput(tty, "-g")
	if err != nil {
		return Dark, false
	}
	if err := sttyRun(tty, "raw", "-echo", "min", "0", "time", "1"); err != nil {
		return Dark, false
	}
	defer sttyRun(tty, strings.TrimSpace(string(state)))

	if _, err := tty.Write([]byte("\x1b]11;?\a")); err != nil {
		return Dark, false
	}

	deadline := time.Now().Add(timeout)
	var buffer []byte
	for time.Now().Before(deadline) {
		remaining := int(time.Until(deadline) / time.Millisecond)
		if remaining < 1 {
			remaining = 1
		}
		events := []unix.PollFd{{
			Fd:     int32(tty.Fd()),
			Events: unix.POLLIN,
		}}
		count, err := unix.Poll(events, remaining)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			break
		}
		if count == 0 {
			break
		}
		chunk := make([]byte, 128)
		read, err := tty.Read(chunk)
		if read > 0 {
			buffer = append(buffer, chunk[:read]...)
			if mode, ok := ParseTerminalThemeReport(buffer); ok {
				return mode, true
			}
		}
		if err != nil {
			break
		}
	}
	return ParseTerminalThemeReport(buffer)
}

func sttyOutput(tty *os.File, args ...string) ([]byte, error) {
	cmd := exec.Command("stty", args...)
	cmd.Stdin = tty
	return cmd.Output()
}

func sttyRun(tty *os.File, args ...string) error {
	cmd := exec.Command("stty", args...)
	cmd.Stdin = tty
	return cmd.Run()
}
