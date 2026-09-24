package themerun

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

const (
	lineFeed                = '\n'
	singleQuote             = '\''
	doubleQuote             = '"'
	minimumQuotedTextLength = 2 * quoteCharacterCount
)

var protocolQueries = map[TerminalProtocol][]string{
	TerminalProtocolBackground:  {ansi.RequestBackgroundColor},
	TerminalProtocolColorScheme: {ansi.RequestLightDarkReport, ansi.RequestBackgroundColor},
}

var themePriorities = Priorities[Theme]{Dark, Light}

func modeFromEvent(event uv.Event) (Theme, bool) {
	switch event := event.(type) {
	case uv.DarkColorSchemeEvent:
		return Dark, true
	case uv.LightColorSchemeEvent:
		return Light, true
	case uv.BackgroundColorEvent:
		if event.Color == nil {
			return "", false
		}
		if event.IsDark() {
			return Dark, true
		}
		return Light, true
	}
	return "", false
}

func ModeFromText(runtime Runtime, text string) (Theme, bool) {
	normalized := strings.TrimSpace(text)
	lower := strings.ToLower(normalized)
	for _, theme := range themePriorities {
		if strings.Contains(lower, string(theme)) {
			return theme, true
		}
	}
	if len(normalized) >= minimumQuotedTextLength &&
		((normalized[0] == singleQuote && normalized[len(normalized)-quoteCharacterCount] == singleQuote) ||
			(normalized[0] == doubleQuote && normalized[len(normalized)-quoteCharacterCount] == doubleQuote)) {
		normalized = normalized[quoteCharacterCount : len(normalized)-quoteCharacterCount]
	}
	for _, theme := range themePriorities {
		for _, alias := range runtime.ThemeAliases[theme] {
			if strings.EqualFold(normalized, alias) {
				return theme, true
			}
		}
	}
	return "", false
}

func TerminalQuery(runtime Runtime, env Variables) string {
	queries := terminalQueries(runtime, env)
	if len(queries) == 0 {
		return ansi.RequestBackgroundColor
	}
	return queries[0]
}

func terminalQueries(runtime Runtime, env Variables) []string {
	identifiers := Priorities[string]{
		env[runtime.ThemeTerminalProgramEnvironment],
		env[terminalEnvironment],
		terminalFallbackName,
	}
	protocol, ok := identifiers.LookupFunc(runtime.ThemeTerminalQueries, strings.EqualFold)
	if !ok {
		return nil
	}
	return protocolQueries[protocol]
}

func Detect(runtime Runtime, env Variables, withTerminal bool) Theme {
	if mode, ok := detectEnvironment(runtime, env); ok {
		return mode
	}
	if withTerminal {
		for _, query := range terminalQueries(runtime, env) {
			if mode, ok := probeTerminal(query, time.Duration(runtime.ThemeProbeTimeoutMS)*time.Millisecond); ok {
				return mode
			}
		}
	}
	commands, fallback := PlatformCommands(runtime)
	for _, command := range commands {
		if mode, ok := commandMode(runtime, env, command); ok {
			return mode
		}
	}
	return fallback
}

func detectEnvironment(runtime Runtime, env Variables) (Theme, bool) {
	for _, name := range runtime.ThemeEnvironment {
		if mode, ok := ModeFromText(runtime, env[name]); ok {
			return mode, true
		}
	}
	return "", false
}

func probeTerminal(query string, timeout time.Duration) (Theme, bool) {
	input, output, err := uv.OpenTTY()
	if err != nil {
		return "", false
	}
	defer func() { _ = input.Close() }()
	if output != input {
		defer func() { _ = output.Close() }()
	}
	console := uv.NewConsole(input, output, nil)
	if _, err := console.MakeRaw(); err != nil {
		return "", false
	}
	defer func() { _ = console.Restore() }()
	reader, err := uv.NewCancelReader(console.Reader())
	if err != nil {
		return "", false
	}
	defer func() { _ = reader.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	events := make(chan uv.Event)
	terminalReader := uv.NewTerminalReader(reader, "")
	go func() {
		defer close(events)
		_ = terminalReader.StreamEvents(ctx, events)
	}()
	defer func() {
		cancel()
		if !reader.Cancel() {
			_ = input.Close()
		}
		// StreamEvents may flush pending events while shutting down.
		for range events {
		}
	}()
	if _, err := io.WriteString(console.Writer(), query); err != nil {
		return "", false
	}
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return "", false
			}
			if mode, ok := modeFromEvent(event); ok {
				return mode, true
			}
		case <-ctx.Done():
			return "", false
		}
	}
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

var errOutputLimit = errors.New("helper output limit exceeded")

func (b *limitedBuffer) Write(input []byte) (int, error) {
	remaining := b.limit - b.Len()
	if remaining <= 0 {
		return 0, errOutputLimit
	}
	if len(input) > remaining {
		_, _ = b.Buffer.Write(input[:remaining])
		return remaining, errOutputLimit
	}
	return b.Buffer.Write(input)
}

func commandMode(runtime Runtime, env Variables, argv []string) (Theme, bool) {
	output, err := runCommandOutput(runtime, env, argv)
	if err != nil {
		return "", false
	}
	return ModeFromText(runtime, output)
}

func runCommandOutput(runtime Runtime, env Variables, argv []string) (string, error) {
	if len(argv) == 0 {
		return "", errors.New("empty helper command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(runtime.HelperTimeoutMS)*time.Millisecond)
	defer cancel()
	command := exec.CommandContext(ctx, argv[0], argv[1:]...)
	command.Env = envList(env)
	command.WaitDelay = time.Duration(runtime.HelperTimeoutMS) * time.Millisecond
	stdout := &limitedBuffer{limit: runtime.HelperOutputLimitBytes}
	stderr := &limitedBuffer{limit: runtime.HelperOutputLimitBytes}
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		return "", err
	}
	return stdout.String(), nil
}
