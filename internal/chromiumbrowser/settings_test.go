package chromiumbrowser

import (
	"os"
	"path/filepath"
	"testing"
)

func TestApplyProfileSettingsContinuesWhenExtensionStorageIsBroken(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, "Default")
	storageDir := filepath.Join(profileDir, "Local Extension Settings", "broken-extension")
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storageDir, "CURRENT"), []byte("MANIFEST-000001\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	browser := Browser{
		ExecutableName: "test-browser",
		DefaultProfileDir: func(string) string {
			return profileDir
		},
		PreferencePatches: []PreferencePatch{
			func(preferences map[string]any) {
				preferences["preferences-applied"] = true
			},
		},
	}

	err := browser.ApplyProfileSettings(ApplyOptions{
		ProfileDir: profileDir,
		SettingsSource: []SettingsSource{
			{
				Name: "test settings",
				Data: []byte(`{
					"local": [
						{
							"id": "broken-extension",
							"values": {
								"enabled": true
							}
						}
					]
				}`),
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	preferences, err := ReadPreferences(profileDir)
	if err != nil {
		t.Fatal(err)
	}
	if preferences["preferences-applied"] != true {
		t.Fatalf("preferences-applied = %v, want true", preferences["preferences-applied"])
	}
}
