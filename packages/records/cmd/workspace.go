package main

import (
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"unicode/utf8"

	set "github.com/hashicorp/go-set/v3"
)

type workspaceFormat struct {
	Collections []string `json:"collections"`
	Version     int      `json:"version"`
}

type recordMetadata struct {
	Executable bool     `json:"executable"`
	Paths      []string `json:"paths"`
	Private    bool     `json:"private"`
	Render     bool     `json:"render"`
	Systems    []string `json:"systems"`
}

func (v *vault) unpackWorkspace(destination string) (returnErr error) {
	root, created, err := v.prepareDestination(destination)
	if err != nil {
		return err
	}
	defer func() {
		if returnErr == nil {
			return
		}
		if created {
			_ = os.RemoveAll(root)
			return
		}
		empty, emptyErr := directoryEmpty(root)
		if emptyErr == nil && !empty {
			_, _ = fmt.Fprintf(v.stderr, "records: protected workspace retained at %s\n", root)
		}
	}()

	value, err := v.decryptCollections()
	if err != nil {
		return err
	}
	if err := writeWorkspace(root, value); err != nil {
		return err
	}
	_, err = fmt.Fprintf(v.stdout, "unpacked %d records into %s\n", recordCount(value), root)
	return err
}

func (v *vault) packWorkspace(source string) error {
	root, err := v.existingWorkspace(source)
	if err != nil {
		return err
	}
	value, err := readWorkspace(root)
	if err != nil {
		return err
	}
	current, err := v.decryptCollections()
	if err != nil {
		return err
	}
	if equalCollections(value, current) {
		return unchanged(v.stdout)
	}
	return v.packCollections(value)
}

func (v *vault) check(source string) error {
	var value collectionSet
	var err error
	if source == "" {
		value, err = v.decryptCollections()
	} else {
		var root string
		root, err = v.existingWorkspace(source)
		if err == nil {
			value, err = readWorkspace(root)
		}
	}
	if err != nil {
		return err
	}
	if source == "" {
		exists, statErr := pathExists(v.marker)
		if statErr != nil {
			return statErr
		}
		if exists {
			if err := v.checkMaterialized(value); err != nil {
				return err
			}
		}
	}
	_, err = fmt.Fprintf(v.stdout, "validated %d records\n", recordCount(value))
	return err
}

func (v *vault) checkMaterialized(value collectionSet) error {
	if err := v.requireUnpackedMarker(); err != nil {
		return err
	}
	if err := v.validateIgnoreOverlay(value); err != nil {
		return err
	}
	sources, err := v.sourceFiles(value)
	if err != nil {
		return err
	}
	excluded := make([]string, 0, len(sources)+2)
	for _, source := range sources {
		excluded = append(excluded, source.path)
	}
	excluded = append(excluded, v.ignore, v.searchIgnore)
	if err := v.validateLocalExcludes(excluded); err != nil {
		return err
	}
	if err := v.validateSearchIgnore(sources); err != nil {
		return err
	}
	plaintext, err := v.collectionsWithSourceBodies(value)
	if err != nil {
		return err
	}
	if !equalCollections(plaintext, value) {
		return errors.New("plaintext records differ from the encrypted vault; run `just records-pack`")
	}
	return nil
}

func (v *vault) prepareDestination(destination string) (string, bool, error) {
	path, err := expandPath(destination)
	if err != nil {
		return "", false, err
	}
	exists, err := pathExists(path)
	if err != nil {
		return "", false, err
	}
	if exists {
		directory, dirErr := isDirectory(path)
		if dirErr != nil {
			return "", false, dirErr
		}
		empty, emptyErr := directoryEmpty(path)
		if !directory || emptyErr != nil || !empty {
			return "", false, fmt.Errorf("workspace must be an empty directory: %s", path)
		}
		root, workspaceErr := v.existingWorkspace(path)
		return root, false, workspaceErr
	}
	parentDirectory, err := isDirectory(filepath.Dir(path))
	if err != nil {
		return "", false, err
	}
	if !parentDirectory {
		return "", false, fmt.Errorf("workspace parent does not exist: %s", filepath.Dir(path))
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", false, err
	}
	resolved := filepath.Join(parent, filepath.Base(path))
	if isWithin(v.repository, resolved) {
		return "", false, errors.New("plaintext workspaces must be outside the repository")
	}
	if err := os.Mkdir(resolved, 0o700); err != nil {
		return "", false, err
	}
	return resolved, true, nil
}

func (v *vault) existingWorkspace(source string) (string, error) {
	path, err := expandPath(source)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("workspace is not a directory: %s", path)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("workspace must not be a symlink: %s", path)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("workspace is not a directory: %s", path)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	if isWithin(v.repository, path) {
		return "", errors.New("plaintext workspaces must be outside the repository")
	}
	info, err = os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("workspace permissions must not grant group or other access")
	}
	return path, nil
}

func writeWorkspace(root string, value collectionSet) error {
	format, err := marshalPrettyJSON(workspaceFormat{
		Collections: collectionNames,
		Version:     formatVersion,
	})
	if err != nil {
		return err
	}
	if err := writePrivate(filepath.Join(root, "format.json"), append(format, '\n')); err != nil {
		return err
	}
	for _, collection := range collectionNames {
		collectionRoot := filepath.Join(root, collection)
		if err := os.Mkdir(collectionRoot, 0o700); err != nil {
			return err
		}
		for index, item := range value[collection] {
			recordRoot := filepath.Join(collectionRoot, fmt.Sprintf("%03d", index))
			if err := os.Mkdir(recordRoot, 0o700); err != nil {
				return err
			}
			metadata, err := marshalPrettyJSON(item.metadata())
			if err != nil {
				return err
			}
			if err := writePrivate(filepath.Join(recordRoot, "metadata.json"), append(metadata, '\n')); err != nil {
				return err
			}
			if err := writePrivate(filepath.Join(recordRoot, "body"), []byte(item.Body)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (item record) metadata() recordMetadata {
	return recordMetadata{
		Executable: item.Executable,
		Paths:      item.Paths,
		Private:    item.Private,
		Render:     item.Render,
		Systems:    item.Systems,
	}
}

func readWorkspace(root string) (collectionSet, error) {
	if err := assertEntries(root, slices.Concat([]string{"format.json"}, collectionNames)); err != nil {
		return nil, err
	}
	formatPath := filepath.Join(root, "format.json")
	regular, err := isRegular(formatPath)
	if err != nil {
		return nil, err
	}
	if !regular {
		return nil, errors.New("missing workspace format")
	}
	content, err := os.ReadFile(formatPath)
	if err != nil {
		return nil, err
	}
	var format workspaceFormat
	if err := json.Unmarshal(content, &format, json.RejectUnknownMembers(true)); err != nil {
		return nil, fmt.Errorf("workspace format is not valid JSON (%v)", err)
	}
	if format.Version != formatVersion ||
		!collectionNameSet.EqualSliceSet(format.Collections) {
		return nil, errors.New("unsupported workspace format")
	}

	result := make(collectionSet, len(collectionNames))
	for _, collection := range collectionNames {
		collectionRoot := filepath.Join(root, collection)
		directory, err := isDirectory(collectionRoot)
		if err != nil {
			return nil, err
		}
		if !directory {
			return nil, fmt.Errorf("missing collection directory: %s", collection)
		}
		entries, err := os.ReadDir(collectionRoot)
		if err != nil {
			return nil, err
		}
		records := make([]record, len(entries))
		for index, entry := range entries {
			expectedName := fmt.Sprintf("%03d", index)
			recordRoot := filepath.Join(collectionRoot, entry.Name())
			directory, dirErr := isDirectory(recordRoot)
			if dirErr != nil {
				return nil, dirErr
			}
			if !directory || entry.Name() != expectedName {
				return nil, fmt.Errorf(
					"%s record directories must be contiguous and zero-padded",
					collection,
				)
			}
			item, itemErr := readWorkspaceRecord(recordRoot, collection, index)
			if itemErr != nil {
				return nil, itemErr
			}
			records[index] = item
		}
		result[collection] = records
	}
	if err := validateCollections(result); err != nil {
		return nil, err
	}
	return result, nil
}

func readWorkspaceRecord(root, collection string, index int) (record, error) {
	if err := assertEntries(root, []string{"body", "metadata.json"}); err != nil {
		return record{}, err
	}
	label := fmt.Sprintf("%s record %03d metadata", collection, index)
	metadata, err := parseJSONObject(filepath.Join(root, "metadata.json"), label)
	if err != nil {
		return record{}, err
	}
	bodyPath := filepath.Join(root, "body")
	regular, err := isRegular(bodyPath)
	if err != nil {
		return record{}, err
	}
	if !regular {
		return record{}, fmt.Errorf("%s record %03d body must be a regular file", collection, index)
	}
	body, err := os.ReadFile(bodyPath)
	if err != nil {
		return record{}, err
	}
	if !utf8.Valid(body) {
		return record{}, fmt.Errorf("%s record %03d body must be UTF-8 text", collection, index)
	}
	bodyJSON, err := marshalJSON(string(body))
	if err != nil {
		return record{}, err
	}
	metadata["body"] = jsontext.Value(bodyJSON)
	raw, err := marshalJSON(metadata)
	if err != nil {
		return record{}, err
	}
	return decodeRecord(raw, collection, index)
}

func assertEntries(directory string, expected []string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	actual := make([]string, len(entries))
	for index, entry := range entries {
		actual[index] = entry.Name()
	}
	if set.From(expected).EqualSlice(actual) {
		return nil
	}
	return fmt.Errorf("unexpected files in protected workspace: %s", directory)
}

func directoryEmpty(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	return len(entries) == 0, err
}

func validateEditTarget(collection, index string) error {
	if index != "" && collection == "" {
		return errors.New("an index requires a collection")
	}
	if collection != "" && !collectionNameSet.Contains(collection) {
		return fmt.Errorf("unknown collection: %s", collection)
	}
	if index == "" {
		return nil
	}
	parsed, err := strconv.Atoi(index)
	if err != nil || parsed < 0 {
		return errors.New("record index must be a non-negative integer")
	}
	return nil
}
