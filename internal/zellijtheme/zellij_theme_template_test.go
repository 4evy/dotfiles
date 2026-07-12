package zellijtheme

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"text/template"
)

func renderZellijThemeTemplate(t *testing.T) string {
	t.Helper()
	repoRoot := filepath.Join("..", "..")
	palettePath := filepath.Join(repoRoot, "internal", "zellijtheme", "catppuccin_palette.json")
	sharedPath := filepath.Join(repoRoot, "dotfiles", ".chezmoitemplates", "catppuccin_zellij_pink.kdl.tmpl")
	themePath := filepath.Join(repoRoot, "dotfiles", "dot_config", "zellij", "themes", "catppuccin.kdl.tmpl")

	functions := template.FuncMap{
		"include": func(string) (string, error) {
			contents, err := os.ReadFile(palettePath)
			return string(contents), err
		},
		"fromJson": func(contents string) (map[string]any, error) {
			var value map[string]any
			err := json.Unmarshal([]byte(contents), &value)
			return value, err
		},
	}
	tmpl, err := template.New(filepath.Base(themePath)).Funcs(functions).ParseFiles(sharedPath, themePath)
	if err != nil {
		t.Fatal(err)
	}
	var rendered bytes.Buffer
	if err := tmpl.ExecuteTemplate(&rendered, filepath.Base(themePath), nil); err != nil {
		t.Fatal(err)
	}
	return rendered.String()
}

func TestRenderedZellijThemeHasCompleteSemanticStyles(t *testing.T) {
	rendered := renderZellijThemeTemplate(t)
	for _, themeName := range []string{"catppuccin-latte-pink", "catppuccin-frappe-pink"} {
		if !strings.Contains(rendered, themeName+" {") {
			t.Fatalf("rendered theme is missing %s", themeName)
		}
	}
	for _, section := range []string{
		"text_unselected",
		"text_selected",
		"ribbon_selected",
		"ribbon_unselected",
		"table_title",
		"table_cell_selected",
		"table_cell_unselected",
		"list_selected",
		"list_unselected",
		"frame_unselected",
		"frame_selected",
		"frame_highlight",
		"exit_code_success",
		"exit_code_error",
		"multiplayer_user_colors",
	} {
		if count := strings.Count(rendered, "    "+section+" {"); count != 2 {
			t.Errorf("semantic section %s appears %d times, want 2", section, count)
		}
	}
	if strings.Contains(rendered, "\n    fg ") || strings.Contains(rendered, "\n    bg ") {
		t.Error("rendered theme unexpectedly fell back to the legacy palette format")
	}
}

func TestRenderedZellijThemeKeepsAccentAndStatusRolesSeparate(t *testing.T) {
	rendered := renderZellijThemeTemplate(t)
	for _, expected := range []string{
		"frame_selected {\n      base \"#ea76cb\"",
		"frame_selected {\n      base \"#f4b8e4\"",
		"ribbon_selected {\n      base \"#dce0e8\"\n      background \"#ea76cb\"",
		"ribbon_selected {\n      base \"#292c3c\"\n      background \"#f4b8e4\"",
		"exit_code_success {\n      base \"#40a02b\"",
		"exit_code_success {\n      base \"#a6d189\"",
		"exit_code_error {\n      base \"#d20f39\"",
		"exit_code_error {\n      base \"#e78284\"",
		"frame_unselected {\n      base \"#ccd0da\"",
		"frame_unselected {\n      base \"#414559\"",
	} {
		if !strings.Contains(rendered, expected) {
			t.Errorf("rendered theme is missing semantic mapping %q", expected)
		}
	}

	for _, expected := range []string{
		"player_1 \"#ea76cb\"", "player_2 \"#1e66f5\"", "player_3 \"#8839ef\"",
		"player_4 \"#df8e1d\"", "player_5 \"#04a5e5\"", "player_6 \"#fe640b\"",
		"player_7 \"#d20f39\"", "player_8 \"#7287fd\"", "player_9 \"#dd7878\"",
		"player_10 \"#e64553\"",
		"player_1 \"#f4b8e4\"", "player_2 \"#8caaee\"", "player_3 \"#ca9ee6\"",
		"player_4 \"#e5c890\"", "player_5 \"#99d1db\"", "player_6 \"#ef9f76\"",
		"player_7 \"#e78284\"", "player_8 \"#babbf1\"", "player_9 \"#eebebe\"",
		"player_10 \"#ea999c\"",
	} {
		if !strings.Contains(rendered, expected) {
			t.Errorf("rendered multiplayer palette is missing %s", expected)
		}
	}
}

func TestZellijLayoutsUseAdaptiveTerminalColors(t *testing.T) {
	repoRoot := filepath.Join("..", "..")
	for _, name := range []string{"compact.kdl.tmpl", "default.kdl.tmpl"} {
		path := filepath.Join(repoRoot, "dotfiles", "dot_config", "zellij", "layouts", name)
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		layout := string(contents)
		if strings.Contains(layout, "catppuccin_palette") || strings.Contains(layout, "#f4b8e4") {
			t.Errorf("%s hard-codes a single Catppuccin flavor", name)
		}
		for _, expected := range []string{
			"#[fg=blue,reverse,bold] NORMAL ",
			"#[fg=magenta,reverse,bold] RESIZE ",
			"#[fg=red,reverse,bold] SESSION ",
			"#[fg=magenta,bold]{session}",
			"#[fg=default,bold] {name} ",
		} {
			if !strings.Contains(layout, expected) {
				t.Errorf("%s is missing adaptive style %q", name, expected)
			}
		}
	}
}

func TestZellijConfigEnablesAutomaticCatppuccinSwitching(t *testing.T) {
	path := filepath.Join("..", "..", "dotfiles", "dot_config", "zellij", "config.kdl.tmpl")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := string(contents)
	for _, expected := range []string{
		"theme \"catppuccin-frappe-pink\"",
		"theme_dark \"catppuccin-frappe-pink\"",
		"theme_light \"catppuccin-latte-pink\"",
	} {
		if !strings.Contains(config, expected) {
			t.Errorf("Zellij config is missing %q", expected)
		}
	}
}

func TestStartupPaneDefaultsMatchCatppuccinTerminalColors(t *testing.T) {
	for _, test := range []struct {
		theme Theme
		fg    string
		bg    string
	}{
		{theme: Latte, fg: "#4c4f69", bg: "#eff1f5"},
		{theme: Frappe, fg: "#c6d0f5", bg: "#303446"},
	} {
		if test.theme.Colors.FG != test.fg || test.theme.Colors.BG != test.bg {
			t.Errorf("%s pane colors = %#v, want fg=%s bg=%s", test.theme.Name, test.theme.Colors, test.fg, test.bg)
		}
	}
}
