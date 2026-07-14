package terminaltheme

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/lucasb-eyer/go-colorful"
)

type Colors struct {
	FG string
	BG string
}

type Theme struct {
	Name   string
	Colors Colors
}

type TerminalThemeMode int

const (
	Dark TerminalThemeMode = iota
	Light
)

//go:embed catppuccin_palette.json
var catppuccinPaletteJSON []byte

var catppuccinPalette = mustParseCatppuccinPalette()

var (
	Frappe = themeFromPalette("catppuccin-frappe-pink", "frappe")
	Latte  = themeFromPalette("catppuccin-latte-pink", "latte")
)

type catppuccinPaletteMap map[string]map[string]string

func mustParseCatppuccinPalette() catppuccinPaletteMap {
	var palette catppuccinPaletteMap
	if err := json.Unmarshal(catppuccinPaletteJSON, &palette); err != nil {
		panic(err)
	}
	return palette
}

func themeFromPalette(name, flavor string) Theme {
	colors, ok := catppuccinPalette[flavor]
	if !ok {
		panic("missing Catppuccin flavor: " + flavor)
	}
	return Theme{
		Name: name,
		Colors: Colors{
			FG: mustPaletteColor(colors, flavor, "text"),
			BG: mustPaletteColor(colors, flavor, "base"),
		},
	}
}

func mustPaletteColor(colors map[string]string, flavor, name string) string {
	color := colors[name]
	if color == "" {
		panic("missing Catppuccin color: " + flavor + "." + name)
	}
	return color
}

type themeProbePlan struct {
	fallback Theme
	commands [][]string
}

var unixThemeProbeCommands = [][]string{
	{"gsettings", "get", "org.gnome.desktop.interface", "color-scheme"},
	{"gsettings", "get", "org.gnome.desktop.interface", "gtk-theme"},
}

var systemThemeProbePlans = map[string]themeProbePlan{
	"darwin": {
		fallback: Latte,
		commands: [][]string{
			{"defaults", "read", "-g", "AppleInterfaceStyle"},
		},
	},
	"linux":     {fallback: Frappe, commands: unixThemeProbeCommands},
	"freebsd":   {fallback: Frappe, commands: unixThemeProbeCommands},
	"dragonfly": {fallback: Frappe, commands: unixThemeProbeCommands},
	"netbsd":    {fallback: Frappe, commands: unixThemeProbeCommands},
	"openbsd":   {fallback: Frappe, commands: unixThemeProbeCommands},
}

func DetectSystemTheme() Theme {
	for _, name := range []string{"COLOR_SCHEME", "TERMINAL_THEME", "THEME"} {
		if mode, ok := themeModeFromText(os.Getenv(name)); ok {
			return themeForMode(mode)
		}
	}
	if mode, ok := detectTerminalTheme(100 * time.Millisecond); ok {
		return themeForMode(mode)
	}
	plan, ok := systemThemeProbePlans[runtime.GOOS]
	if !ok {
		return Frappe
	}
	for _, command := range plan.commands {
		output, err := exec.Command(command[0], command[1:]...).Output()
		if err == nil {
			if mode, ok := themeModeFromText(string(output)); ok {
				return themeForMode(mode)
			}
		}
	}
	return plan.fallback
}

func themeForMode(mode TerminalThemeMode) Theme {
	if mode == Light {
		return Latte
	}
	return Frappe
}

func themeModeFromText(text string) (TerminalThemeMode, bool) {
	text = strings.ToLower(strings.TrimSpace(text))
	if strings.Contains(text, "dark") {
		return Dark, true
	}
	if strings.Contains(text, "light") {
		return Light, true
	}
	switch strings.Trim(text, "'\"") {
	case "frappe", "macchiato", "mocha", "catppuccin-frappe-pink":
		return Dark, true
	case "latte", "catppuccin-latte-pink":
		return Light, true
	}
	return Dark, false
}

func ParseTerminalThemeReport(buffer []byte) (TerminalThemeMode, bool) {
	if bytes.Contains(buffer, []byte("\x1b[?997;1n")) {
		return Dark, true
	}
	if bytes.Contains(buffer, []byte("\x1b[?997;2n")) {
		return Light, true
	}

	parser := ansi.NewParser()
	state := byte(0)
	for len(buffer) > 0 {
		_, _, n, nextState := ansi.DecodeSequence(buffer, state, parser)
		if n <= 0 {
			return Dark, false
		}
		if parser.Command() == 11 {
			if mode, ok := themeModeFromOSC11Data(parser.Data()); ok {
				return mode, true
			}
		}
		state = nextState
		buffer = buffer[n:]
	}
	return Dark, false
}

func themeModeFromOSC11Data(data []byte) (TerminalThemeMode, bool) {
	value, ok := strings.CutPrefix(string(data), "11;")
	if !ok {
		return Dark, false
	}
	value = strings.TrimPrefix(value, "rgb:")
	red, rest, ok := strings.Cut(value, "/")
	if !ok {
		return Dark, false
	}
	green, blue, ok := strings.Cut(rest, "/")
	if !ok || strings.Contains(blue, "/") {
		return Dark, false
	}
	r, ok := parseColorComponent(red)
	if !ok {
		return Dark, false
	}
	g, ok := parseColorComponent(green)
	if !ok {
		return Dark, false
	}
	b, ok := parseColorComponent(blue)
	if !ok {
		return Dark, false
	}
	linearRed, linearGreen, linearBlue := (colorful.Color{R: r, G: g, B: b}).LinearRgb()
	luminance := 0.2126*linearRed + 0.7152*linearGreen + 0.0722*linearBlue
	if luminance > 0.5 {
		return Light, true
	}
	return Dark, true
}

func parseColorComponent(value string) (float64, bool) {
	if value == "" || len(value) > 4 {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 16, 16)
	if err != nil {
		return 0, false
	}
	maxValue := uint64(1<<(len(value)*4)) - 1
	return float64(parsed) / float64(maxValue), true
}
