package main

import (
	"bytes"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/renameio/v2"
	set "github.com/hashicorp/go-set/v3"
)

const (
	formatVersion = 1
	layoutVersion = 1
)

var (
	collectionSchemas = map[string]collectionSchema{
		"t0": {
			fields: set.From([]string{
				"body",
				"executable",
				"paths",
				"private",
				"render",
				"systems",
			}),
			booleanFields: []string{"private", "executable", "render"},
		},
	}
	collectionNames            = slices.Sorted(maps.Keys(collectionSchemas))
	collectionNameSet          = set.From(collectionNames)
	directoryAttributePrefixes = []string{"exact_", "private_", "readonly_"}
	supportedSystems           = set.From([]string{"darwin", "linux"})
)

type collectionSchema struct {
	fields        *set.Set[string]
	booleanFields []string
}

type record struct {
	Body       string   `json:"body"`
	Executable bool     `json:"executable"`
	Paths      []string `json:"paths"`
	Private    bool     `json:"private"`
	Render     bool     `json:"render"`
	Systems    []string `json:"systems"`
}

type collectionSet map[string][]record

type recordRef struct {
	collection string
	index      int
	record     record
}

func (value collectionSet) records() iter.Seq[recordRef] {
	return func(yield func(recordRef) bool) {
		for _, collection := range collectionNames {
			for index, item := range value[collection] {
				if !yield(recordRef{collection: collection, index: index, record: item}) {
					return
				}
			}
		}
	}
}

func collectRecords[T any](value collectionSet, transform func(recordRef) ([]T, error)) ([]T, error) {
	var result []T
	for current := range value.records() {
		items, err := transform(current)
		if err != nil {
			return nil, err
		}
		result = append(result, items...)
	}
	return result, nil
}

func (value collectionSet) clone() collectionSet {
	result := make(collectionSet, len(value))
	for collection, records := range value {
		result[collection] = slices.Clone(records)
	}
	return result
}

type vault struct {
	repository   string
	file         string
	marker       string
	source       string
	ignore       string
	searchIgnore string
	sops         string
	stdout       io.Writer
	stderr       io.Writer
}

func newVault(stdout, stderr io.Writer) (*vault, error) {
	repository := envOr("RECORDS_REPOSITORY", defaultRepository())
	repository, err := filepath.EvalSymlinks(repository)
	if err != nil {
		return nil, fmt.Errorf("resolve records repository: %w", err)
	}
	repository, err = filepath.Abs(repository)
	if err != nil {
		return nil, fmt.Errorf("resolve records repository: %w", err)
	}

	result := &vault{
		repository: repository,
		sops:       envOr("RECORDS_SOPS", "sops"),
		stdout:     stdout,
		stderr:     stderr,
	}
	paths := []struct {
		environment string
		destination *string
		fallback    func() string
	}{
		{
			environment: "RECORDS_FILE",
			destination: &result.file,
			fallback: func() string {
				return filepath.Join(repository, "secrets", "records.yaml")
			},
		},
		{
			environment: "RECORDS_MARKER",
			destination: &result.marker,
			fallback: func() string {
				return filepath.Join(repository, ".records-unpacked")
			},
		},
		{
			environment: "RECORDS_SOURCE",
			destination: &result.source,
			fallback: func() string {
				return filepath.Join(repository, "dotfiles")
			},
		},
		{
			environment: "RECORDS_IGNORE_OVERLAY",
			destination: &result.ignore,
			fallback: func() string {
				return filepath.Join(result.source, ".chezmoitemplates", "records-ignore")
			},
		},
		{
			environment: "RECORDS_SEARCH_IGNORE",
			destination: &result.searchIgnore,
			fallback: func() string {
				return filepath.Join(repository, ".ignore")
			},
		},
	}
	for _, setting := range paths {
		resolved, err := expandPath(envOr(setting.environment, setting.fallback()))
		if err != nil {
			return nil, err
		}
		*setting.destination = resolved
	}
	return result, nil
}

func defaultRepository() string {
	candidates := make([]string, 0, 3)
	if workingDirectory, err := os.Getwd(); err == nil {
		candidates = append(candidates, workingDirectory)
	}
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(executable))
	}
	if _, sourceFile, _, ok := runtime.Caller(0); ok {
		candidates = append(candidates, filepath.Dir(sourceFile))
	}
	for _, candidate := range candidates {
		if repository, ok := findRepository(candidate); ok {
			return repository
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return "."
}

func findRepository(start string) (string, bool) {
	current, err := filepath.Abs(start)
	if err != nil {
		return "", false
	}
	for {
		records, _ := isRegular(filepath.Join(current, "secrets", "records.yaml"))
		config, _ := isRegular(filepath.Join(current, ".sops.yaml"))
		if records && config {
			return current, true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", false
		}
		current = parent
	}
}

func envOr(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}

func expandPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve path %q: %w", path, err)
	}
	return filepath.Clean(absolute), nil
}

func (v *vault) decryptCollections(files ...string) (collectionSet, error) {
	file := v.file
	if len(files) == 1 {
		file = files[0]
	}
	output, err := v.runSOPS(nil,
		"decrypt",
		"--input-type", "yaml",
		"--output-type", "json",
		"--extract", `["items"]`,
		file,
	)
	if err != nil {
		return collectionSet{}, err
	}

	var items map[string]jsontext.Value
	if err := json.Unmarshal(output, &items); err != nil {
		return nil, fmt.Errorf("encrypted manifest is not valid JSON (%v)", err)
	}

	result := make(collectionSet, len(collectionNames))
	for _, collection := range collectionNames {
		encoded, ok := items[collection]
		if !ok {
			return nil, fmt.Errorf("encrypted manifest is missing a collection (%s)", collection)
		}
		if encoded.Kind() != '"' {
			return nil, fmt.Errorf("encrypted %s manifest must be a string", collection)
		}
		var manifest string
		if err := json.Unmarshal(encoded, &manifest); err != nil {
			return nil, fmt.Errorf("encrypted %s manifest must be a string", collection)
		}
		if jsontext.Value(manifest).Kind() != '[' {
			return nil, fmt.Errorf("%s manifest must be an array", collection)
		}
		var rawRecords []jsontext.Value
		if err := json.Unmarshal([]byte(manifest), &rawRecords); err != nil {
			return nil, fmt.Errorf("encrypted manifest is not valid JSON (%v)", err)
		}

		records := make([]record, len(rawRecords))
		for index, raw := range rawRecords {
			parsed, err := decodeRecord(raw, collection, index)
			if err != nil {
				return nil, err
			}
			records[index] = parsed
		}
		result[collection] = records
	}
	if err := validateCollections(result); err != nil {
		return nil, err
	}
	return result, nil
}

func decodeRecord(raw jsontext.Value, collection string, index int) (record, error) {
	label := fmt.Sprintf("%s record %03d", collection, index)
	var fields map[string]jsontext.Value
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return record{}, fmt.Errorf("%s must be an object", label)
	}
	schema, ok := collectionSchemas[collection]
	if !ok {
		return record{}, fmt.Errorf("unknown collection: %s", collection)
	}
	if !schema.fields.EqualSliceSet(slices.Collect(maps.Keys(fields))) {
		return record{}, fmt.Errorf("%s has unexpected fields", label)
	}
	if fields["body"].Kind() != '"' {
		return record{}, fmt.Errorf("%s body must be UTF-8 text", label)
	}
	if fields["paths"].Kind() != '[' {
		return record{}, fmt.Errorf("%s paths must be unique safe relative paths", label)
	}
	if fields["systems"].Kind() != '[' {
		return record{}, fmt.Errorf("%s systems must contain unique supported systems", label)
	}
	for _, field := range schema.booleanFields {
		kind := fields[field].Kind()
		if kind != 't' && kind != 'f' {
			return record{}, fmt.Errorf("%s %s must be boolean", label, field)
		}
	}
	var result record
	if err := json.Unmarshal(raw, &result, json.RejectUnknownMembers(true)); err != nil {
		return record{}, fmt.Errorf("%s has invalid field types", label)
	}
	return result, nil
}

func validateCollections(value collectionSet) error {
	if !collectionNameSet.EqualSliceSet(slices.Collect(maps.Keys(value))) {
		return fmt.Errorf("manifest must contain exactly %s", strings.Join(collectionNames, ", "))
	}
	targets := make(map[string]*set.Set[string], len(collectionNames))
	for _, collection := range collectionNames {
		targets[collection] = set.New[string](0)
	}
	for current := range value.records() {
		label := fmt.Sprintf("%s record %03d", current.collection, current.index)
		if err := validateRecord(current.record, label); err != nil {
			return err
		}
		for _, target := range current.record.Paths {
			if !targets[current.collection].Insert(target) {
				return fmt.Errorf("%s destinations must be unique", current.collection)
			}
		}
	}
	return nil
}

func validateRecord(item record, label string) error {
	if !utf8.ValidString(item.Body) {
		return fmt.Errorf("%s body must be UTF-8 text", label)
	}
	if len(item.Paths) == 0 || set.From(item.Paths).Size() != len(item.Paths) {
		return fmt.Errorf("%s paths must be unique safe relative paths", label)
	}
	for _, target := range item.Paths {
		if !validRelativePath(target) {
			return fmt.Errorf("%s paths must be unique safe relative paths", label)
		}
	}
	if item.Systems == nil || set.From(item.Systems).Size() != len(item.Systems) ||
		!supportedSystems.ContainsSlice(item.Systems) {
		return fmt.Errorf("%s systems must contain unique supported systems", label)
	}
	return nil
}

func validRelativePath(value string) bool {
	return value != "." && !strings.ContainsRune(value, 0) && fs.ValidPath(value)
}

func (v *vault) packCollections(value collectionSet) error {
	items := make(map[string]string, len(collectionNames))
	for _, collection := range collectionNames {
		manifest, err := marshalJSON(value[collection])
		if err != nil {
			return err
		}
		items[collection] = string(manifest)
	}
	encodedItems, err := marshalJSON(items)
	if err != nil {
		return err
	}
	if err := v.replaceVault(encodedItems, value); err != nil {
		return err
	}
	_, err = fmt.Fprintf(v.stdout, "packed %d records into the encrypted vault\n", recordCount(value))
	return err
}

func (v *vault) replaceVault(encodedItems []byte, expected collectionSet) error {
	info, err := os.Stat(v.file)
	if err != nil {
		return err
	}
	input, err := os.Open(v.file)
	if err != nil {
		return err
	}
	defer func() { _ = input.Close() }()

	scratch, err := os.CreateTemp(filepath.Dir(v.file), filepath.Base(v.file)+".sops.*")
	if err != nil {
		return err
	}
	scratchPath := scratch.Name()
	defer func() { _ = os.Remove(scratchPath) }()
	if _, err := io.Copy(scratch, input); err != nil {
		_ = scratch.Close()
		return err
	}
	if err := scratch.Close(); err != nil {
		return err
	}

	_, err = v.runSOPS(encodedItems,
		"--filename-override", v.file,
		"set",
		"--input-type", "yaml",
		"--output-type", "yaml",
		"--idempotent",
		"--value-stdin",
		scratchPath,
		`["items"]`,
	)
	if err != nil {
		return err
	}
	roundTrip, err := v.decryptCollections(scratchPath)
	if err != nil {
		return err
	}
	if !equalCollections(roundTrip, expected) {
		return errors.New("encrypted vault did not round-trip")
	}

	updated, err := os.Open(scratchPath)
	if err != nil {
		return err
	}
	defer func() { _ = updated.Close() }()
	replacement, err := renameio.NewPendingFile(
		v.file,
		renameio.WithStaticPermissions(info.Mode().Perm()),
	)
	if err != nil {
		return err
	}
	defer func() { _ = replacement.Cleanup() }()
	if _, err := io.Copy(replacement, updated); err != nil {
		return err
	}
	return replacement.CloseAtomicallyReplace()
}

func (v *vault) runSOPS(stdin []byte, arguments ...string) ([]byte, error) {
	command := exec.Command(v.sops, arguments...)
	command.Stdin = bytes.NewReader(stdin)
	command.Env = sopsEnvironment(v.repository)
	output, err := commandOutput(command)
	if err != nil {
		return nil, fmt.Errorf("sops command failed: %w", err)
	}
	return output, nil
}

func sopsEnvironment(repository string) []string {
	environment := environmentMap(os.Environ())
	config := filepath.Join(repository, ".sops.yaml")
	if environment["SOPS_CONFIG"] == "" {
		if regular, _ := isRegular(config); regular {
			environment["SOPS_CONFIG"] = config
		}
	}
	helper := filepath.Join(repository, "dotfiles", "dot_local", "bin", "executable_sops-age-key-1password")
	if environment["SOPS_AGE_KEY_CMD"] == "" && runtime.GOOS == "darwin" {
		if executable, _ := isExecutable(helper); executable {
			environment["SOPS_AGE_KEY_CMD"] = helper
		}
	}
	return flattenEnvironment(environment)
}

func environmentMap(environment []string) map[string]string {
	result := make(map[string]string, len(environment))
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if found {
			result[name] = value
		}
	}
	return result
}

func flattenEnvironment(environment map[string]string) []string {
	names := slices.Sorted(maps.Keys(environment))
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+environment[name])
	}
	return result
}

func equalCollections(left, right collectionSet) bool {
	leftJSON, leftErr := marshalJSON(left)
	rightJSON, rightErr := marshalJSON(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func recordCount(value collectionSet) int {
	count := 0
	for _, records := range value {
		count += len(records)
	}
	return count
}

func unchanged(stdout io.Writer) error {
	_, err := fmt.Fprintln(stdout, "records unchanged")
	return err
}
