package chromiumbrowser

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/charmbracelet/log"
	lzstring "github.com/daku10/go-lz-string"
	"github.com/syndtr/goleveldb/leveldb"
)

const defaultRefinedGitHubID = "hlepfoohegkhhmjieoechaddaejaokhf"

type settingsFile struct {
	Local []extensionSettings `json:"local"`
	Sync  []extensionSettings `json:"sync"`
}

type extensionSettings struct {
	ID     string         `json:"id"`
	Values map[string]any `json:"values"`
}

func ApplyExtensionSettings(options ApplyOptions) error {
	sources := slices.Clone(options.SettingsSource)
	for _, path := range options.Settings {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read settings file %s: %w", path, err)
		}
		sources = append(sources, SettingsSource{Name: path, Data: data})
	}

	for _, source := range sources {
		var settings settingsFile
		decoder := json.NewDecoder(bytes.NewReader(source.Data))
		decoder.UseNumber()
		if err := decoder.Decode(&settings); err != nil {
			return fmt.Errorf("parse settings file %s: %w", source.Name, err)
		}
		for _, entry := range settings.Local {
			entry.ID = resolveExtensionID(options.ExtensionIDAliases, entry.ID)
			if err := writeStorageValues(
				options.ProfileDir,
				"Local Extension Settings",
				entry,
			); err != nil {
				return err
			}
		}
		for _, entry := range settings.Sync {
			entry.ID = resolveExtensionID(options.ExtensionIDAliases, entry.ID)
			if err := writeStorageValues(
				options.ProfileDir,
				"Sync Extension Settings",
				entry,
			); err != nil {
				return err
			}
		}
	}

	if !options.GitHubToken {
		return nil
	}
	return applyRefinedGitHubToken(options)
}

func applyRefinedGitHubToken(options ApplyOptions) error {
	tokenFunc := options.TokenFunc
	if tokenFunc == nil {
		tokenFunc = func() string {
			command := exec.Command("gh", "auth", "token")
			output, err := command.Output()
			if err == nil {
				return strings.TrimSpace(string(output))
			}
			log.Warn(
				"chromium: gh auth token failed; skipping Refined GitHub token setup",
				"error",
				err,
			)
			return ""
		}
	}
	token := tokenFunc()
	if token == "" {
		return nil
	}

	return withStorage(
		options.ProfileDir,
		"Sync Extension Settings",
		options.ExtensionIDs.refinedGitHubID(),
		func(db *leveldb.DB) error {
			raw, err := db.Get([]byte("options"), nil)
			refinedOptions := map[string]any{}
			if err == nil {
				var compressed string
				if err := json.Unmarshal(raw, &compressed); err != nil {
					return fmt.Errorf("parse stored Refined GitHub options: %w", err)
				}
				decompressed, err := lzstring.DecompressFromEncodedURIComponent(compressed)
				if err != nil {
					return fmt.Errorf("decompress Refined GitHub options: %w", err)
				}
				if decompressed != "" {
					decoder := json.NewDecoder(strings.NewReader(decompressed))
					decoder.UseNumber()
					if err := decoder.Decode(&refinedOptions); err != nil {
						return fmt.Errorf("parse Refined GitHub options: %w", err)
					}
				}
			} else if !errors.Is(err, leveldb.ErrNotFound) {
				return fmt.Errorf("read Refined GitHub options: %w", err)
			}
			refinedOptions["personalToken"] = token

			encoded, err := json.Marshal(refinedOptions)
			if err != nil {
				return fmt.Errorf("encode Refined GitHub options: %w", err)
			}
			compressed, err := lzstring.CompressToEncodedURIComponent(string(encoded))
			if err != nil {
				return fmt.Errorf("compress Refined GitHub options: %w", err)
			}
			stored, err := json.Marshal(compressed)
			if err != nil {
				return fmt.Errorf("encode compressed Refined GitHub options: %w", err)
			}
			return db.Put([]byte("options"), stored, nil)
		},
	)
}

func (ids ExtensionIDs) refinedGitHubID() string {
	if ids.RefinedGitHub != "" {
		return ids.RefinedGitHub
	}
	return defaultRefinedGitHubID
}

func resolveExtensionID(aliases map[string]string, id string) string {
	if alias := aliases[id]; alias != "" {
		return alias
	}
	return id
}

func writeStorageValues(profileDir, area string, entry extensionSettings) error {
	return withStorage(profileDir, area, entry.ID, func(db *leveldb.DB) error {
		batch := new(leveldb.Batch)
		for key, value := range entry.Values {
			encoded, err := json.Marshal(value)
			if err != nil {
				return fmt.Errorf("encode %s/%s/%s: %w", area, entry.ID, key, err)
			}
			batch.Put([]byte(key), encoded)
		}
		return db.Write(batch, nil)
	})
}

func withStorage(profileDir, area, extensionID string, operation func(*leveldb.DB) error) error {
	path := filepath.Join(profileDir, area, extensionID)
	if err := os.MkdirAll(path, 0o755); err != nil {
		return fmt.Errorf("create storage directory %s: %w", path, err)
	}
	db, err := leveldb.OpenFile(path, nil)
	if err != nil {
		return fmt.Errorf("open storage %s: %w", path, err)
	}
	defer db.Close()
	return operation(db)
}

func isStorageTemporarilyUnavailable(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "resource temporarily unavailable") ||
		strings.Contains(message, "file missing")
}
