package chromiumbrowser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteWrapperParsesAndQuotesFlags(t *testing.T) {
	target := filepath.Join(t.TempDir(), "helium-browser")
	options := &InstallOptions{
		Flags: `--user-data-dir "/tmp/Helium Profile" --name "O'Brien"`,
		extraWrapperFlags: []string{
			"--class=helium-browser",
		},
	}

	if err := writeWrapper(target, "/opt/Helium/helium-wrapper", options); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(
		text,
		`"DESKTOP_STARTUP_ID",`,
	) {
		t.Fatalf("wrapper %q does not clear startup notification tokens", text)
	}
	for _, want := range []string{
		`"FONTCONFIG_SYSROOT",`,
		`os.environ.setdefault("FONTCONFIG_FILE", "/etc/fonts/fonts.conf")`,
		`os.environ.setdefault("FONTCONFIG_PATH", "/etc/fonts")`,
		`os.environ["XDG_DATA_DIRS"]`,
		`flags_file = config_home / "helium-flags.conf"`,
		`*flags, *sys.argv[1:]`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("wrapper %q does not contain %q", text, want)
		}
	}
	for _, want := range []string{
		`/opt/Helium/helium-wrapper`,
		"--user-data-dir",
		`/tmp/Helium Profile`,
		"--name",
		`O'Brien`,
		`--class=helium-browser`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("wrapper %q does not contain %q", text, want)
		}
	}
}

func TestLinuxDesktopEntryAddsStartupWMClass(t *testing.T) {
	input := strings.Join([]string{
		"[Desktop Entry]",
		"Name=Helium",
		"Exec=helium %U",
		"Actions=new-window;new-private-window;",
		"",
		"[Desktop Action new-window]",
		"Exec=helium",
		"",
		"[Desktop Action new-private-window]",
		"Exec=helium --incognito",
		"",
	}, "\n")

	got := LinuxDesktopEntry(input, "/home/user/.local/bin/helium-browser", "helium", "helium-browser")

	for _, want := range []string{
		"Exec=/home/user/.local/bin/helium-browser %U",
		"StartupNotify=false",
		"StartupWMClass=helium-browser\n[Desktop Action new-window]",
		"Exec=/home/user/.local/bin/helium-browser\n",
		"Exec=/home/user/.local/bin/helium-browser --incognito",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("desktop entry %q does not contain %q", got, want)
		}
	}
}
