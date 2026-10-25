package main

import (
	json "encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

type deploymentFile struct {
	Type   string `json:"type"`
	Source string `json:"source"`
	Target string `json:"target"`
}

type deploymentManifest struct {
	Version int              `json:"version"`
	Files   []deploymentFile `json:"files"`
}

func (v *vault) deploy(directory string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if directory == "" {
		state := envOr("XDG_STATE_HOME", filepath.Join(home, ".local", "state"))
		directory = filepath.Join(state, "hjem", "records")
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	if isWithin("/nix/store", root) || isWithin(v.repository, root) {
		return errors.New("runtime records must stay outside the repository and Nix store")
	}
	if err := privateDirectory(root); err != nil {
		return err
	}
	value, err := v.decryptCollections()
	if err != nil {
		return err
	}
	manifest := deploymentManifest{Version: 3, Files: []deploymentFile{}}
	for current := range value.records() {
		item := current.record
		if len(item.Systems) != 0 && !slices.Contains(item.Systems, runtime.GOOS) {
			continue
		}
		hostname, err := os.Hostname()
		if err != nil {
			return err
		}
		body := []byte(item.bodyFor(runtime.GOOS, hostname, home))
		mode := os.FileMode(0o600)
		if item.Executable {
			mode = 0o700
		}
		for _, target := range item.Paths {
			path := filepath.Join(root, filepath.FromSlash(target))
			if err := privateSubdirectories(root, filepath.Dir(path)); err != nil {
				return err
			}
			if err := replaceTextFile(path, body, mode); err != nil {
				return err
			}
			manifest.Files = append(manifest.Files, deploymentFile{
				Type: "symlink", Source: path, Target: filepath.Join(home, filepath.FromSlash(target)),
			})
		}
	}
	encoded, err := marshalJSON(manifest)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	manifestPath := filepath.Join(root, ".manifest.json")
	if err := pruneDeployedRecords(root, manifestPath, manifest); err != nil {
		return err
	}
	if err := replaceTextFile(manifestPath, encoded, 0o600); err != nil {
		return err
	}
	_, err = v.stdout.Write(encoded)
	return err
}

func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if resolved != path {
		return errors.New("runtime record directories must not contain symlinks")
	}
	return os.Chmod(path, 0o700)
}

func privateSubdirectories(root, path string) error {
	if root == path {
		return nil
	}
	if !isWithin(root, path) {
		return errors.New("runtime record directory escapes its root")
	}
	if err := privateSubdirectories(root, filepath.Dir(path)); err != nil {
		return err
	}
	return privateDirectory(path)
}

func pruneDeployedRecords(root, manifestPath string, manifest deploymentManifest) error {
	content, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var previous deploymentManifest
	if err := json.Unmarshal(content, &previous, json.RejectUnknownMembers(true)); err != nil {
		return errors.New("invalid previous runtime records manifest")
	}
	if previous.Version != 3 {
		return errors.New("unsupported previous runtime records manifest")
	}
	for _, old := range previous.Files {
		if slices.ContainsFunc(manifest.Files, func(file deploymentFile) bool {
			return file.Source == old.Source
		}) {
			continue
		}
		if old.Type != "symlink" || !isWithin(root, old.Source) || old.Source == manifestPath {
			return errors.New("invalid previous runtime records source")
		}
		regular, err := isRegular(old.Source)
		if err != nil {
			return err
		}
		if regular {
			if err := os.Remove(old.Source); err != nil {
				return err
			}
		}
	}
	return nil
}

func (item record) bodyFor(system, hostname, home string) string {
	body := item.Body
	for _, variant := range item.Variants {
		if variant.System == system && variant.Hostname == "" {
			body = variant.Body
		}
	}
	for _, variant := range item.Variants {
		if variant.System == system && variant.Hostname == hostname {
			body = variant.Body
		}
	}
	if item.Render {
		// Expand the two supported runtime placeholders after variant selection
		body = strings.NewReplacer("@HOME@", home, "@HOSTNAME@", hostname).Replace(body)
	}
	return body
}
