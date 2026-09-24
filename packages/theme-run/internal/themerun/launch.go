package themerun

import (
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/pelletier/go-toml/v2"
	"golang.org/x/sys/unix"
)

const (
	signalExitOffset   = 128
	shebangReadLimit   = 512
	shebangPrefix      = "#!"
	shebangFieldCount  = 2
	shebangCommand     = 0
	shebangArgument    = 1
	minimumProgramArgs = 1
	temporaryMode      = 0o755
	temporaryPattern   = "*"
	pathPrefix         = "~/"
	pathPrefixLength   = len(pathPrefix)
	currentDirectory   = "."
	lineSeparator      = "\n"
	indentCharacters   = " \t"
	assignmentFormat   = "%s = %c%s%c"
	assignmentLine     = assignmentFormat + lineSeparator
	unreachable        = "unreachable"
)

type Prepared struct {
	Args          []string
	Environment   Variables
	TemporaryPath string
}

type Invocation struct {
	Argv          []string
	Environment   Variables
	TemporaryPath string
}

func (i *Invocation) Cleanup() {
	if i.TemporaryPath != "" {
		_ = os.Remove(i.TemporaryPath)
	}
}

func (i *Invocation) Run() (int, error) {
	if i.TemporaryPath == "" {
		if err := syscall.Exec(i.Argv[0], i.Argv, envList(i.Environment)); err != nil {
			return executionStatus(err), err
		}
		panic(unreachable)
	}
	command := exec.Command(i.Argv[0], i.Argv[1:]...)
	command.Env = envList(i.Environment)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	err := command.Run()
	if err == nil {
		return ExitSuccess, nil
	}
	if exit, ok := errors.AsType[*exec.ExitError](err); ok {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return signalExitOffset + int(status.Signal()), nil
		}
		return exit.ExitCode(), nil
	}
	return executionStatus(err), err
}

func PrepareInvocation(manifest *Manifest, runner Runner, requested string, extra []string, env Variables, forcedTheme *Theme) (*Invocation, error) {
	executablePath, err := resolve(runner, requested, env)
	if err != nil {
		return nil, err
	}
	var integration *Integration
	if runner.Integration != "" {
		integration = new(manifest.Integrations[runner.Integration])
	}
	var mode Theme
	if forcedTheme != nil {
		mode = *forcedTheme
	} else {
		mode = Detect(manifest.Runtime, env, true)
	}
	prepared, err := Prepare(manifest.Runtime, integration, extra, env, mode)
	if err != nil {
		return nil, err
	}
	argv := make([]string, 0, len(runner.DefaultArgs)+len(prepared.Args)+minimumProgramArgs)
	if runner.Interpreter != "" && usesInterpreter(manifest.Interpreters[runner.Interpreter], executablePath) {
		interpreterPath, err := findInterpreter(manifest.Interpreters[runner.Interpreter], env)
		if err != nil {
			prepared.cleanup()
			return nil, err
		}
		argv = append(argv, interpreterPath, executablePath)
	} else {
		argv = append(argv, executablePath)
	}
	argv = append(argv, runner.DefaultArgs...)
	argv = append(argv, prepared.Args...)
	childEnv := maps.Clone(env)
	for _, name := range runner.EnvUnset {
		delete(childEnv, name)
	}
	maps.Copy(childEnv, runner.Env)
	maps.Copy(childEnv, prepared.Environment)
	childEnv[ActiveEnv] = activeEnvironmentValue
	return &Invocation{Argv: argv, Environment: childEnv, TemporaryPath: prepared.TemporaryPath}, nil
}

func Prepare(runtime Runtime, integration *Integration, extra []string, env Variables, mode Theme) (Prepared, error) {
	if integration == nil {
		return Prepared{Args: slices.Clone(extra)}, nil
	}
	themeName := integration.LightTheme
	if mode == Dark {
		themeName = integration.DarkTheme
	}
	switch integration.Strategy {
	case IntegrationStrategyArguments:
		context := ""
		if integration.ContextTable != "" {
			var err error
			context, err = directoryContext(runtime, *integration, extra, env)
			if err != nil {
				return Prepared{}, err
			}
		}
		result := Prepared{}
		for _, template := range integration.Arguments {
			result.Args = append(result.Args, render(template, themeName, context))
		}
		result.Args = append(result.Args, extra...)
		return result, nil
	case IntegrationStrategyConfig:
		path, arguments := configArguments(*integration, extra, env)
		contents, err := readFile(path)
		if errors.Is(err, os.ErrNotExist) {
			contents = nil
		} else if err != nil {
			return Prepared{}, err
		}
		patched, err := patchConfig(contents, *integration, themeName)
		if err != nil {
			return Prepared{}, fmt.Errorf("patch %s: %w", integration.DisplayName, err)
		}
		temporaryPath, err := makeTemporary(*integration, patched, env)
		if err != nil {
			return Prepared{}, err
		}
		result := Prepared{TemporaryPath: temporaryPath, Args: []string{integration.ConfigOutputFlag, temporaryPath}}
		result.Args = append(result.Args, arguments...)
		return result, nil
	case IntegrationStrategyEnvironment:
		result := Prepared{Args: slices.Clone(extra), Environment: make(Variables)}
		for key, template := range integration.Env {
			value := render(template, themeName, "")
			value = strings.ReplaceAll(value, homePlaceholder, env[homeEnvironment])
			result.Environment[key] = value
		}
		return result, nil
	default:
		return Prepared{}, fmt.Errorf("unsupported integration strategy %q", integration.Strategy)
	}
}

func (p *Prepared) cleanup() {
	if p.TemporaryPath != "" {
		_ = os.Remove(p.TemporaryPath)
	}
}

func resolve(runner Runner, requested string, env Variables) (string, error) {
	if isPathLike(requested) {
		return requested, nil
	}
	var skipPaths []string
	for _, name := range runner.SkipEnv {
		skipPaths = append(skipPaths, filepath.SplitList(env[name])...)
	}
	if self, err := os.Executable(); err == nil {
		skipPaths = append(skipPaths, self)
	}
	if path, ok := candidate(requested, skipPaths, env); ok {
		return path, nil
	}
	programs := runner.Programs
	if len(programs) == 0 {
		programs = []string{runner.Name}
	}
	for _, program := range programs {
		if program == requested {
			continue
		}
		if path, ok := candidate(program, skipPaths, env); ok {
			return path, nil
		}
	}
	return "", os.ErrNotExist
}

func candidate(raw string, skipPaths []string, env Variables) (string, bool) {
	name := raw
	if strings.HasPrefix(raw, environmentReference) {
		if len(raw) == len(environmentReference) {
			return "", false
		}
		name = env[strings.TrimPrefix(raw, environmentReference)]
		if name == "" {
			return "", false
		}
	}
	name = expandPath(name, env)
	if isPathLike(name) {
		return executableCandidate(name, skipPaths)
	}
	path := cmp.Or(env[pathEnvironment], defaultSearchPath)
	for _, directory := range filepath.SplitList(path) {
		joined := name
		if directory != "" {
			joined = filepath.Join(directory, name)
		}
		if result, ok := executableCandidate(joined, skipPaths); ok {
			return result, true
		}
	}
	return "", false
}

func executableCandidate(path string, skipPaths []string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || unix.Access(path, unix.X_OK) != nil {
		return "", false
	}
	for _, skip := range skipPaths {
		skipped, err := os.Stat(skip)
		if err == nil && os.SameFile(info, skipped) {
			return "", false
		}
	}
	return path, true
}

func isPathLike(value string) bool {
	return filepath.Dir(value) != currentDirectory
}

func expandPath(value string, env Variables) string {
	if strings.HasPrefix(value, pathPrefix) && env[homeEnvironment] != "" {
		return filepath.Join(env[homeEnvironment], value[pathPrefixLength:])
	}
	return value
}

func usesInterpreter(interpreter Interpreter, executablePath string) bool {
	file, err := os.Open(executablePath)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	contents, _ := io.ReadAll(io.LimitReader(file, shebangReadLimit))
	line, _, _ := strings.Cut(string(contents), lineSeparator)
	if !strings.HasPrefix(line, shebangPrefix) {
		return false
	}
	fields := strings.Fields(strings.TrimPrefix(line, shebangPrefix))
	return len(fields) >= shebangFieldCount &&
		slices.Contains(interpreter.ShebangCommands, fields[shebangCommand]) &&
		slices.Contains(interpreter.ShebangArguments, fields[shebangArgument])
}

func findInterpreter(interpreter Interpreter, env Variables) (string, error) {
	for _, program := range interpreter.Programs {
		if path, ok := candidate(program, nil, env); ok {
			return path, nil
		}
	}
	return "", errors.New("interpreter not found")
}

func render(template, themeName, context string) string {
	return strings.NewReplacer(
		themePlaceholder, themeName,
		contextPlaceholder, context,
	).Replace(template)
}

func argumentValue(arguments, flags, prefixes []string, separator string) string {
	result := ""
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if separator != "" && argument == separator {
			break
		}
		if slices.Contains(flags, argument) && index+1 < len(arguments) {
			index++
			result = arguments[index]
		}
		for _, prefix := range prefixes {
			if strings.HasPrefix(argument, prefix) && len(argument) > len(prefix) {
				result = argument[len(prefix):]
			}
		}
	}
	return result
}

func directoryContext(runtime Runtime, integration Integration, arguments []string, env Variables) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	directoryValue := cmp.Or(argumentValue(arguments, integration.ContextPathFlags, integration.ContextPathPrefixes, integration.ContextArgumentSeparator), cwd)
	directory := canonicalDirectory(cwd, directoryValue)
	directories := []string{directory}
	seen := map[string]bool{directory: true}
	for _, commandTemplate := range integration.ContextDirectoryCommands {
		command := make([]string, len(commandTemplate))
		for index, argument := range commandTemplate {
			command[index] = strings.ReplaceAll(argument, directoryPlaceholder, directory)
		}
		output, err := runCommandOutput(runtime, env, command)
		if err != nil {
			continue
		}
		relatedText := strings.TrimSpace(output)
		if relatedText == "" || strings.ContainsRune(relatedText, lineFeed) {
			continue
		}
		related := canonicalDirectory(directory, relatedText)
		info, err := os.Stat(related)
		if err != nil || !info.IsDir() || seen[related] {
			continue
		}
		seen[related] = true
		directories = append(directories, related)
	}
	table := make(map[string]map[string]string, len(directories))
	for _, path := range directories {
		table[path] = map[string]string{
			integration.ContextField: integration.ContextValue,
		}
	}
	var output bytes.Buffer
	encoder := toml.NewEncoder(&output)
	encoder.SetTablesInline(true)
	if err := encoder.Encode(map[string]any{integration.ContextTable: table}); err != nil {
		return "", err
	}
	return strings.TrimSpace(output.String()), nil
}

func canonicalDirectory(base, value string) string {
	path := value
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, path)
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	if absolute, err := filepath.Abs(path); err == nil {
		return absolute
	}
	return filepath.Clean(path)
}

func configArguments(integration Integration, arguments []string, env Variables) (string, []string) {
	path := ""
	foundPath := false
	filtered := make([]string, 0, len(arguments))
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if slices.Contains(integration.ConfigFlags, argument) {
			if index+1 < len(arguments) {
				index++
				if !foundPath {
					path = expandPath(arguments[index], env)
					foundPath = true
				}
			}
			continue
		}
		joined := false
		for _, flag := range integration.ConfigFlags {
			if value, ok := strings.CutPrefix(argument, flag+assignmentSeparator); ok {
				if !foundPath {
					path = expandPath(value, env)
					foundPath = true
				}
				joined = true
				break
			}
		}
		if !joined {
			filtered = append(filtered, argument)
		}
	}
	if !foundPath && env[homeEnvironment] != "" {
		path = filepath.Join(env[homeEnvironment], integration.DefaultConfig)
	}
	return path, filtered
}

func patchConfig(contents []byte, integration Integration, value string) ([]byte, error) {
	if integration.Validation != ValidationTOML {
		return patchAssignment(contents, integration.Assignment, integration.Quote[0], value), nil
	}

	document := make(map[string]any)
	if len(contents) != 0 {
		if err := toml.Unmarshal(contents, &document); err != nil {
			return nil, err
		}
	}
	if current, exists := document[integration.Assignment]; exists {
		switch current.(type) {
		case string, map[string]any:
		default:
			return nil, errors.New("assignment must be a string or table")
		}
	}
	document[integration.Assignment] = value
	return toml.Marshal(document)
}

func patchAssignment(contents []byte, key string, quote byte, value string) []byte {
	var output bytes.Buffer
	replaced := false
	for line := range bytes.Lines(contents) {
		rest, found := bytes.CutPrefix(bytes.TrimLeft(line, indentCharacters), []byte(key))
		if !replaced && found && bytes.HasPrefix(bytes.TrimLeft(rest, indentCharacters), []byte(assignmentSeparator)) {
			fmt.Fprintf(&output, assignmentFormat, key, quote, value, quote)
			if bytes.HasSuffix(line, []byte(lineSeparator)) {
				output.WriteString(lineSeparator)
			}
			replaced = true
		} else {
			output.Write(line)
		}
	}
	if replaced {
		return output.Bytes()
	}
	assignment := fmt.Sprintf(assignmentLine, key, quote, value, quote)
	if output.Len() != 0 && !bytes.HasSuffix(output.Bytes(), []byte(lineSeparator)) {
		output.WriteString(lineSeparator)
	}
	output.WriteString(assignment)
	return output.Bytes()
}

func makeTemporary(integration Integration, contents []byte, env Variables) (string, error) {
	directory := ""
	switch integration.TemporaryLocation {
	case TemporaryLocationSystem:
		directory = cmp.Or(env[temporaryEnvironment], defaultTemporaryPath)
	case TemporaryLocationCache:
		base := env[cacheHomeEnvironment]
		if base == "" && env[homeEnvironment] != "" {
			base = filepath.Join(env[homeEnvironment], cacheDirectoryName)
		}
		directory = filepath.Join(cmp.Or(base, defaultTemporaryPath), integration.CacheSubdirectory)
	}
	if err := os.MkdirAll(directory, temporaryMode); err != nil {
		return "", err
	}
	stem := strings.TrimSuffix(integration.TemporaryPrefix, temporarySuffix)
	file, err := os.CreateTemp(directory, stem+temporaryPattern)
	if err != nil {
		return "", err
	}
	path := file.Name()
	cleanup := true
	defer func() {
		_ = file.Close()
		if cleanup {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(contents); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	cleanup = false
	return path, nil
}

func envList(env Variables) []string {
	keys := slices.Sorted(maps.Keys(env))
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+assignmentSeparator+env[key])
	}
	return result
}

func ExecUnknown(argv []string) (int, error) {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return executionStatus(err), err
	}
	if err := syscall.Exec(path, argv, os.Environ()); err != nil {
		return executionStatus(err), err
	}
	panic(unreachable)
}

func executionStatus(err error) int {
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
		return ExitNotFound
	}
	return ExitCannotExecute
}
