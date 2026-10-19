package main

import (
	"bytes"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"unicode/utf8"

	"github.com/go-ruby-shellwords/shellwords"
	set "github.com/hashicorp/go-set/v3"
)

var (
	localExcludeBlock = newDelimitedBlock(
		"# BEGIN dotfiles encrypted records",
		"# END dotfiles encrypted records",
	)
	searchIgnoreBlock = newDelimitedBlock(
		"# BEGIN dotfiles decrypted records",
		"# END dotfiles decrypted records",
	)
)

type delimitedBlock struct {
	begin   string
	end     string
	pattern *regexp.Regexp
}

func newDelimitedBlock(begin, end string) delimitedBlock {
	return delimitedBlock{
		begin: begin,
		end:   end,
		pattern: regexp.MustCompile(
			`(?ms)^` + regexp.QuoteMeta(begin) + `\n.*?^` + regexp.QuoteMeta(end) + `\n?`,
		),
	}
}

func (block delimitedBlock) remove(content string) string {
	location := block.pattern.FindStringIndex(content)
	if location == nil {
		return content
	}
	return content[:location[0]] + content[location[1]:]
}

func (block delimitedBlock) replace(content string, entries []string) string {
	sections := slices.Concat(
		[]string{trimRightWhitespace(block.remove(content)), block.begin},
		entries,
		[]string{block.end},
	)
	return strings.Join(removeEmptyStrings(sections), "\n")
}

type sourceFile struct {
	path string
	body string
	mode os.FileMode
}

type markerFormat struct {
	Version int `json:"version"`
}

func (v *vault) unpackSource() (returnErr error) {
	value, err := v.decryptCollections()
	if err != nil {
		return err
	}
	sources, err := v.sourceFiles(value)
	if err != nil {
		return err
	}
	excluded := make([]string, 0, len(sources)+1)
	for _, source := range sources {
		excluded = append(excluded, source.path)
	}
	excluded = append(excluded, v.searchIgnore)
	if err := v.updateLocalExcludes(excluded); err != nil {
		return err
	}
	if err := v.rejectSourceConflicts(sources); err != nil {
		return err
	}

	created := make([]string, 0, len(sources))
	defer func() {
		if returnErr == nil {
			return
		}
		for _, path := range slices.Backward(created) {
			regular, _ := isRegular(path)
			if regular {
				_ = os.Remove(path)
			}
		}
	}()
	for _, source := range sources {
		exists, statErr := pathExists(source.path)
		if statErr != nil {
			return statErr
		}
		if !exists {
			if err := os.MkdirAll(filepath.Dir(source.path), 0o700); err != nil {
				return err
			}
			if err := writePrivate(source.path, []byte(source.body)); err != nil {
				return err
			}
			created = append(created, source.path)
		}
		if err := os.Chmod(source.path, source.mode); err != nil {
			return err
		}
	}
	if err := v.writeSearchIgnore(sources); err != nil {
		return err
	}
	if err := v.writeMarker(); err != nil {
		return err
	}
	_, err = fmt.Fprintf(v.stdout, "unpacked %d plaintext files into %s\n", len(sources), v.source)
	return err
}

func (v *vault) packSource() error {
	if err := v.requireUnpackedMarker(); err != nil {
		return err
	}
	current, err := v.decryptCollections()
	if err != nil {
		return err
	}
	sources, err := v.sourceFiles(current)
	if err != nil {
		return err
	}
	if err := v.validateSearchIgnore(sources); err != nil {
		return err
	}
	updated, err := v.collectionsWithSourceBodies(current)
	if err != nil {
		return err
	}
	if equalCollections(updated, current) {
		if err := unchanged(v.stdout); err != nil {
			return err
		}
	} else if err := v.packCollections(updated); err != nil {
		return err
	}
	if err := v.synchronizeSourceFiles(updated); err != nil {
		return err
	}
	return v.concealSourceFiles(updated)
}

func (v *vault) layout() error {
	value, err := v.decryptCollections()
	if err != nil {
		return err
	}
	type row [5]string
	rows, err := collectRecords(value, func(current recordRef) ([]row, error) {
		result := make([]row, 0, len(current.record.Paths))
		for _, target := range current.record.Paths {
			flags := make([]string, 0, 3)
			if current.record.Private {
				flags = append(flags, "private")
			}
			if current.record.Executable {
				flags = append(flags, "executable")
			}
			if current.record.Render {
				flags = append(flags, "render")
			}
			systems := strings.Join(current.record.Systems, ",")
			if systems == "" {
				systems = "all"
			}
			source, sourceErr := v.sourcePathFor(target, current.record)
			if sourceErr != nil {
				return nil, sourceErr
			}
			relative, relativeErr := relativePath(v.repository, source)
			if relativeErr != nil {
				return nil, relativeErr
			}
			attributes := strings.Join(flags, ",")
			if attributes == "" {
				attributes = "-"
			}
			result = append(result, row{
				fmt.Sprintf("%s/%03d", current.collection, current.index),
				systems,
				attributes,
				target,
				relative,
			})
		}
		for index, variant := range current.record.Variants {
			attributes := "variant"
			if variant.Hostname != "" {
				attributes += ",host-specific"
			}
			for _, target := range current.record.Paths {
				source, err := v.variantSourcePath(current, target, index)
				if err != nil {
					return nil, err
				}
				relative, err := relativePath(v.repository, source)
				if err != nil {
					return nil, err
				}
				result = append(result, row{
					fmt.Sprintf("%s/%03d.%03d", current.collection, current.index, index),
					variant.System, attributes, target, relative,
				})
			}
		}
		return result, nil
	})
	if err != nil {
		return err
	}
	output := tabwriter.NewWriter(v.stdout, 0, 0, 2, ' ', 0)
	for _, current := range rows {
		if _, err := fmt.Fprintln(output, strings.Join(current[:], "\t")); err != nil {
			return err
		}
	}
	return output.Flush()
}

func (v *vault) editSource(target string) error {
	if err := v.unpackSource(); err != nil {
		return err
	}
	editor, err := editorCommand()
	if err != nil {
		return err
	}
	editorPath := v.source
	if target != "" {
		value, decryptErr := v.decryptCollections()
		if decryptErr != nil {
			return decryptErr
		}
		editorPath, err = v.resolveEditorTarget(target, value)
		if err != nil {
			return err
		}
	}
	if err := v.runEditor(editor, editorPath); err != nil {
		return err
	}
	return v.packSource()
}

func (v *vault) editWorkspace(collection, index string) (returnErr error) {
	if err := validateEditTarget(collection, index); err != nil {
		return err
	}
	workspace, err := os.MkdirTemp("", "dotfiles-records-")
	if err != nil {
		return err
	}
	completed := false
	defer func() {
		if completed {
			_ = os.RemoveAll(workspace)
		} else {
			_, _ = fmt.Fprintf(v.stderr, "records: protected workspace retained at %s\n", workspace)
		}
	}()
	value, err := v.decryptCollections()
	if err != nil {
		return err
	}
	if err := writeWorkspace(workspace, value); err != nil {
		return err
	}
	target, err := editorWorkspaceTarget(workspace, collection, index)
	if err != nil {
		return err
	}
	editor, err := editorCommand()
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(v.stdout, "editing protected workspace %s\n", workspace); err != nil {
		return err
	}
	if err := v.runEditor(editor, target); err != nil {
		return err
	}
	if err := v.packWorkspace(workspace); err != nil {
		return err
	}
	completed = true
	return nil
}

func editorCommand() ([]string, error) {
	setting, found := os.LookupEnv("VISUAL")
	if !found {
		setting = os.Getenv("EDITOR")
	}
	editor, err := shellwords.Split(setting)
	if err != nil {
		return nil, fmt.Errorf("parse VISUAL or EDITOR: %w", err)
	}
	if len(editor) == 0 {
		return nil, errors.New("VISUAL or EDITOR must name an editor")
	}
	return editor, nil
}

func (v *vault) runEditor(editor []string, path string) error {
	command := exec.Command(editor[0], append(editor[1:], path)...)
	command.Stdin = os.Stdin
	command.Stdout = v.stdout
	command.Stderr = v.stderr
	return command.Run()
}

func editorWorkspaceTarget(workspace, collection, index string) (string, error) {
	if collection == "" {
		return workspace, nil
	}
	if index == "" {
		return filepath.Join(workspace, collection), nil
	}
	parsed, _ := strconv.Atoi(index)
	target := filepath.Join(workspace, collection, fmt.Sprintf("%03d", parsed))
	directory, err := isDirectory(target)
	if err != nil {
		return "", err
	}
	if !directory {
		return "", errors.New("record does not exist")
	}
	return target, nil
}

func (v *vault) sourceFiles(value collectionSet) ([]sourceFile, error) {
	seen := set.New[string](0)
	return collectRecords(value, func(current recordRef) ([]sourceFile, error) {
		item := current.record
		result := make([]sourceFile, 0, len(item.Paths))
		mode := os.FileMode(0o600)
		if item.Executable {
			mode = 0o700
		}
		for variant := -1; variant < len(item.Variants); variant++ {
			body := item.Body
			if variant >= 0 {
				body = item.Variants[variant].Body
			}
			for _, target := range item.Paths {
				path, err := v.variantSourcePath(current, target, variant)
				if err != nil {
					return nil, err
				}
				if !seen.Insert(path) {
					return nil, fmt.Errorf("%s record %03d has a duplicate source path", current.collection, current.index)
				}
				result = append(result, sourceFile{path: path, body: body, mode: mode})
			}
		}
		return result, nil
	})
}

func (v *vault) sourcePathFor(target string, _ record) (string, error) {
	if !validRelativePath(target) {
		return "", errors.New("record target must be a safe relative path")
	}
	return filepath.Join(v.source, filepath.FromSlash(target)), nil
}

func (v *vault) rejectSourceConflicts(sources []sourceFile) error {
	conflicts := make([]string, 0)
	for _, source := range sources {
		exists, err := pathExists(source.path)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		regular, err := isRegular(source.path)
		if err != nil {
			return err
		}
		if regular {
			content, readErr := os.ReadFile(source.path)
			if readErr != nil {
				return readErr
			}
			if bytes.Equal(content, []byte(source.body)) {
				continue
			}
		}
		relative, _ := relativePath(v.repository, source.path)
		conflicts = append(conflicts, relative)
	}
	if len(conflicts) == 0 {
		return nil
	}
	return fmt.Errorf("refusing to overwrite changed plaintext records: %s", strings.Join(conflicts, ", "))
}

func (v *vault) variantSourcePath(current recordRef, target string, variant int) (string, error) {
	path, err := v.sourcePathFor(target, current.record)
	if err != nil || variant < 0 {
		return path, err
	}
	return filepath.Join(v.source, ".variants", current.collection,
		fmt.Sprintf("%03d", current.index), fmt.Sprintf("%03d", variant), filepath.FromSlash(target)), nil
}

func (v *vault) collectionsWithSourceBodies(value collectionSet) (collectionSet, error) {
	updated := value.clone()
	for current := range value.records() {
		for variant := -1; variant < len(current.record.Variants); variant++ {
			body, err := v.readSourceBody(current, variant)
			if err != nil {
				return nil, err
			}
			if variant < 0 {
				updated[current.collection][current.index].Body = body
			} else {
				updated[current.collection][current.index].Variants[variant].Body = body
			}
		}
	}
	if err := validateCollections(updated); err != nil {
		return nil, err
	}
	return updated, nil
}

func (v *vault) readSourceBody(current recordRef, variant int) (string, error) {
	bodies := make([]string, 0, len(current.record.Paths))
	for _, target := range current.record.Paths {
		path, err := v.variantSourcePath(current, target, variant)
		if err != nil {
			return "", err
		}
		label, _ := relativePath(v.repository, path)
		regular, err := isRegular(path)
		if err != nil {
			return "", err
		}
		if !regular {
			return "", fmt.Errorf("missing plaintext record: %s", label)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if !utf8.Valid(body) {
			return "", fmt.Errorf("plaintext record must be UTF-8 text: %s", label)
		}
		bodies = append(bodies, string(body))
	}
	original := current.record.Body
	if variant >= 0 {
		original = current.record.Variants[variant].Body
	}
	return mergedSourceBody(bodies, original, current.collection, current.index)
}

func mergedSourceBody(bodies []string, original, collection string, index int) (string, error) {
	unique := set.From(bodies)
	if unique.Size() == 1 {
		for body := range unique.Items() {
			return body, nil
		}
	}
	if unique.Size() == 2 && unique.Contains(original) {
		for candidate := range unique.Items() {
			if candidate != original {
				return candidate, nil
			}
		}
	}
	return "", fmt.Errorf(
		"plaintext copies for %s record %03d contain conflicting edits",
		collection,
		index,
	)
}

func (v *vault) synchronizeSourceFiles(value collectionSet) error {
	sources, err := v.sourceFiles(value)
	if err != nil {
		return err
	}
	for _, source := range sources {
		content, err := os.ReadFile(source.path)
		if err != nil {
			return err
		}
		if !bytes.Equal(content, []byte(source.body)) {
			if err := replaceTextFile(source.path, []byte(source.body), source.mode); err != nil {
				return err
			}
		}
		if err := os.Chmod(source.path, source.mode); err != nil {
			return err
		}
	}
	return nil
}

func (v *vault) concealSourceFiles(value collectionSet) error {
	sources, err := v.sourceFiles(value)
	if err != nil {
		return err
	}
	for _, source := range sources {
		label, _ := relativePath(v.repository, source.path)
		regular, err := isRegular(source.path)
		if err != nil {
			return err
		}
		if !regular {
			return fmt.Errorf("refusing to remove unverified plaintext record: %s", label)
		}
		content, err := os.ReadFile(source.path)
		if err != nil {
			return err
		}
		if !bytes.Equal(content, []byte(source.body)) {
			return fmt.Errorf("refusing to remove unverified plaintext record: %s", label)
		}
	}
	if err := v.validateSearchIgnore(sources); err != nil {
		return err
	}
	if err := v.requireUnpackedMarker(); err != nil {
		return err
	}
	if err := v.clearSearchIgnore(); err != nil {
		return err
	}
	removable := make([]string, 0, len(sources)+1)
	for _, source := range sources {
		removable = append(removable, source.path)
	}
	removable = append(removable, v.marker)
	for _, path := range removable {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	seenDirectories := set.New[string](len(removable))
	for _, path := range removable {
		directory := filepath.Dir(path)
		if seenDirectories.Insert(directory) {
			if err := v.removeEmptySourceDirectories(directory); err != nil {
				return err
			}
		}
	}
	if err := v.clearLocalExcludes(); err != nil {
		return err
	}
	_, err = fmt.Fprintf(v.stdout, "concealed %d plaintext files in the encrypted vault\n", len(sources))
	return err
}

func (v *vault) removeEmptySourceDirectories(directory string) error {
	current := directory
	for current != v.source && isWithin(v.source, current) {
		directory, err := isDirectory(current)
		if err != nil {
			return err
		}
		if !directory {
			return nil
		}
		empty, err := directoryEmpty(current)
		if err != nil || !empty {
			return err
		}
		if err := os.Remove(current); err != nil {
			return err
		}
		current = filepath.Dir(current)
	}
	return nil
}

func (v *vault) updateLocalExcludes(paths []string) error {
	exclude, err := v.localExcludePath()
	if err != nil {
		return err
	}
	directory, err := isDirectory(filepath.Dir(exclude))
	if err != nil {
		return err
	}
	if !directory {
		return fmt.Errorf("git exclude directory does not exist: %s", filepath.Dir(exclude))
	}
	current, mode, err := readOptionalTextFile(exclude)
	if err != nil {
		return err
	}
	entries, err := v.localExcludeEntries(paths)
	if err != nil {
		return err
	}
	if err := replaceTextFile(exclude, []byte(localExcludeBlock.replace(current, entries)), mode); err != nil {
		return err
	}
	return v.verifyGitExcludes(paths)
}

func (v *vault) validateLocalExcludes(paths []string) error {
	exclude, err := v.localExcludePath()
	if err != nil {
		return err
	}
	regular, err := isRegular(exclude)
	if err != nil {
		return err
	}
	if !regular {
		return errors.New("missing local Git exclude file, run `just records unpack`")
	}
	content, err := os.ReadFile(exclude)
	if err != nil {
		return err
	}
	entries, err := v.localExcludeEntries(paths)
	if err != nil {
		return err
	}
	if string(content) != localExcludeBlock.replace(string(content), entries) {
		return errors.New("local Git exclude block is stale, run `just records unpack`")
	}
	if err := v.verifyGitExcludes(paths); err != nil {
		return errors.New("plaintext records are not excluded from Git, run `just records unpack`")
	}
	return nil
}

func (v *vault) localExcludeEntries(paths []string) ([]string, error) {
	entries := make([]string, 0, len(paths)+1)
	for _, path := range slices.Concat([]string{v.marker}, paths) {
		relative, err := relativePath(v.repository, path)
		if err != nil {
			return nil, err
		}
		entries = append(entries, "/"+relative)
	}
	slices.Sort(entries)
	return entries, nil
}

func (v *vault) verifyGitExcludes(paths []string) error {
	for _, path := range paths {
		relative, _ := relativePath(v.repository, path)
		if _, err := v.runGit("check-ignore", "--quiet", "--no-index", "--", relative); err != nil {
			return err
		}
	}
	marker, _ := relativePath(v.repository, v.marker)
	_, err := v.runGit("check-ignore", "--quiet", "--no-index", "--", marker)
	return err
}

func (v *vault) clearLocalExcludes() error {
	exclude, err := v.localExcludePath()
	if err != nil {
		return err
	}
	regular, err := isRegular(exclude)
	if err != nil || !regular {
		return err
	}
	content, err := os.ReadFile(exclude)
	if err != nil {
		return err
	}
	info, err := os.Stat(exclude)
	if err != nil {
		return err
	}
	retained := trimRightWhitespace(localExcludeBlock.remove(string(content)))
	if retained != "" {
		retained += "\n"
	}
	return replaceTextFile(exclude, []byte(retained), info.Mode().Perm())
}

func (v *vault) localExcludePath() (string, error) {
	output, err := v.runGit("rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return "", err
	}
	path := strings.TrimSpace(string(output))
	if !filepath.IsAbs(path) {
		path = filepath.Join(v.repository, path)
	}
	return filepath.Clean(path), nil
}

func (v *vault) runGit(arguments ...string) ([]byte, error) {
	output, err := runCommand("git", slices.Concat([]string{"-C", v.repository}, arguments)...)
	if err == nil {
		return output, nil
	}
	return nil, fmt.Errorf("git command failed: %w", err)
}

func (v *vault) writeSearchIgnore(sources []sourceFile) error {
	relative, _ := relativePath(v.repository, v.searchIgnore)
	tracked, err := v.gitTracked(v.searchIgnore)
	if err != nil {
		return err
	}
	if tracked {
		return fmt.Errorf("refusing to modify tracked ripgrep ignore file: %s", relative)
	}
	exists, err := pathExists(v.searchIgnore)
	if err != nil {
		return err
	}
	if exists {
		regular, regularErr := isRegular(v.searchIgnore)
		if regularErr != nil {
			return regularErr
		}
		if !regular {
			return fmt.Errorf("ripgrep ignore overlay must be a regular file: %s", relative)
		}
	}
	current, mode, err := readOptionalTextFile(v.searchIgnore)
	if err != nil {
		return err
	}
	content, err := v.searchIgnoreContent(current, sources)
	if err != nil {
		return err
	}
	if err := replaceTextFile(v.searchIgnore, []byte(content), mode); err != nil {
		return err
	}
	return os.Chmod(v.searchIgnore, 0o600)
}

func (v *vault) validateSearchIgnore(sources []sourceFile) error {
	regular, err := isRegular(v.searchIgnore)
	if err != nil {
		return err
	}
	if !regular {
		return errors.New("missing local ripgrep ignore overlay")
	}
	content, err := os.ReadFile(v.searchIgnore)
	if err != nil {
		return err
	}
	expected, err := v.searchIgnoreContent(string(content), sources)
	if err != nil {
		return err
	}
	if string(content) != expected {
		return errors.New("local ripgrep ignore overlay is stale, run `just records unpack`")
	}
	return nil
}

func (v *vault) clearSearchIgnore() error {
	regular, err := isRegular(v.searchIgnore)
	if err != nil || !regular {
		return err
	}
	content, err := os.ReadFile(v.searchIgnore)
	if err != nil {
		return err
	}
	retained := trimRightWhitespace(searchIgnoreBlock.remove(string(content)))
	if retained == "" {
		return os.Remove(v.searchIgnore)
	}
	info, err := os.Stat(v.searchIgnore)
	if err != nil {
		return err
	}
	return replaceTextFile(v.searchIgnore, []byte(retained+"\n"), info.Mode().Perm())
}

func (v *vault) searchIgnoreContent(current string, sources []sourceFile) (string, error) {
	entries := make([]string, 0, len(sources))
	for _, source := range sources {
		relative, err := relativePath(v.repository, source.path)
		if err != nil {
			return "", err
		}
		entries = append(entries, "!/"+escapeIgnorePattern(relative))
	}
	slices.Sort(entries)
	return searchIgnoreBlock.replace(current, entries) + "\n", nil
}

func escapeIgnorePattern(path string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`*`, `\*`,
		`?`, `\?`,
		`[`, `\[`,
		`]`, `\]`,
	)
	return replacer.Replace(path)
}

func (v *vault) gitTracked(path string) (bool, error) {
	relative, err := relativePath(v.repository, path)
	if err != nil {
		return false, err
	}
	command := exec.Command("git", "-C", v.repository, "ls-files", "--error-unmatch", "--", relative)
	if err := command.Run(); err == nil {
		return true, nil
	} else if _, ok := errors.AsType[*exec.ExitError](err); ok {
		return false, nil
	} else {
		return false, err
	}
}

func (v *vault) writeMarker() error {
	content, err := marshalJSON(markerFormat{Version: layoutVersion})
	if err != nil {
		return err
	}
	content = append(content, '\n')
	exists, err := pathExists(v.marker)
	if err != nil {
		return err
	}
	if !exists {
		return writePrivate(v.marker, content)
	}
	regular, err := isRegular(v.marker)
	if err != nil {
		return err
	}
	if !regular {
		return fmt.Errorf("records marker must be a regular file: %s", v.marker)
	}
	if err := replaceTextFile(v.marker, content, 0o600); err != nil {
		return err
	}
	return os.Chmod(v.marker, 0o600)
}

func (v *vault) requireUnpackedMarker() error {
	regular, err := isRegular(v.marker)
	if err != nil {
		return err
	}
	if !regular {
		return errors.New("records are not unpacked, run `just records unpack` first")
	}
	content, err := os.ReadFile(v.marker)
	if err != nil {
		return err
	}
	var marker markerFormat
	if err := json.Unmarshal(content, &marker, json.RejectUnknownMembers(true)); err != nil {
		return fmt.Errorf("records marker is not valid JSON (%v)", err)
	}
	if marker.Version != layoutVersion {
		return errors.New("unsupported records marker")
	}
	return nil
}

func (v *vault) resolveEditorTarget(target string, value collectionSet) (string, error) {
	candidate, err := expandPath(target)
	if err == nil && isWithin(v.repository, candidate) {
		sources, sourceErr := v.sourceFiles(value)
		if sourceErr != nil {
			return "", sourceErr
		}
		for _, source := range sources {
			if candidate == source.path {
				return candidate, nil
			}
		}
	}
	normalized := normalizeTargetPath(target)
	for current := range value.records() {
		for _, candidate := range current.record.Paths {
			if candidate == normalized {
				return v.sourcePathFor(candidate, current.record)
			}
		}
	}
	return "", fmt.Errorf("unknown record path: %s", target)
}

func normalizeTargetPath(target string) string {
	if relative, ok := strings.CutPrefix(target, "~/"); ok {
		return relative
	}
	if !filepath.IsAbs(target) {
		return target
	}
	home := os.Getenv("HOME")
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return target
		}
	}
	if isWithin(home, target) {
		relative, relativeErr := relativePath(home, target)
		if relativeErr == nil {
			return relative
		}
	}
	return target
}

func readOptionalTextFile(path string) (string, os.FileMode, error) {
	regular, err := isRegular(path)
	if err != nil {
		return "", 0, err
	}
	if !regular {
		return "", 0o600, nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	return string(content), info.Mode().Perm(), nil
}

func removeEmptyStrings(values []string) []string {
	return slices.DeleteFunc(slices.Clone(values), func(value string) bool {
		return value == ""
	})
}
