package terminaltheme

import (
	"strings"
	"testing"
)

func TestBtopThemeReplacement(t *testing.T) {
	got, err := patchINI(
		"foo = true\ncolor_theme = \"old\"\n",
		[]configUpdateSpec{
			{
				Path:  "color_theme",
				Dark:  "catppuccin_latte_pink",
				Light: "catppuccin_latte_pink",
				Quote: true,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `color_theme = "catppuccin_latte_pink"`) ||
		strings.Contains(got, "old") {
		t.Fatalf("theme replacement failed: %s", got)
	}
}

func TestKDLThemeReplacement(t *testing.T) {
	got, err := patchKDL(
		"theme \"old\"\ndefault_layout \"compact\"\n",
		[]configUpdateSpec{{Path: "theme", Dark: Frappe.Name, Light: Frappe.Name}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `theme "catppuccin-frappe-pink"`) || strings.Contains(got, `"old"`) {
		t.Fatalf("kdl replacement failed: %s", got)
	}
}

func TestConfiguredProgramNames(t *testing.T) {
	got := strings.Join(ConfiguredProgramNames(), ",")
	for _, want := range []string{"btop", "codex", "ghostty", "helix"} {
		if !strings.Contains(got, want) {
			t.Fatalf("program names %q missing %q", got, want)
		}
	}
}

func TestStripConfigArgs(t *testing.T) {
	got := stripArgs(
		[]string{"--config", "one", "-c", "two", "--config=three", "--preset", "1"},
		[]string{"--config", "-c"},
	)
	if strings.Join(got, ",") != "--preset,1" {
		t.Fatalf("stripped args = %#v", got)
	}
}

func TestTerminalThemeReport(t *testing.T) {
	if got, ok := ParseTerminalThemeReport([]byte("\x1b[?997;1n")); !ok || got != Dark {
		t.Fatalf("dark report = %v, %v", got, ok)
	}
	if got, ok := ParseTerminalThemeReport(
		[]byte("\x1b]11;rgb:efff/f1f1/f5f5\a"),
	); !ok ||
		got != Light {
		t.Fatalf("light osc11 = %v, %v", got, ok)
	}
	if got, ok := ParseTerminalThemeReport(
		[]byte("prefix\x1b]11;rgb:3030/3434/4646\x1b\\suffix"),
	); !ok ||
		got != Dark {
		t.Fatalf("dark osc11 = %v, %v", got, ok)
	}
}

func TestThemeModeFromGnomeDefaults(t *testing.T) {
	for _, text := range []string{"'default'", "'Adwaita'"} {
		if got, ok := themeModeFromText(text); ok {
			t.Fatalf("%q = %v, want no detected mode", text, got)
		}
	}
	if got, ok := themeModeFromText("'Adwaita-dark'"); !ok || got != Dark {
		t.Fatalf("Adwaita-dark = %v, %v, want dark", got, ok)
	}
}

func TestThemeModeFromCatppuccinNames(t *testing.T) {
	if got, ok := themeModeFromText("catppuccin-frappe-pink"); !ok || got != Dark {
		t.Fatalf("frappe = %v, %v, want dark", got, ok)
	}
	if got, ok := themeModeFromText("catppuccin-latte-pink"); !ok || got != Light {
		t.Fatalf("latte = %v, %v, want light", got, ok)
	}
}
