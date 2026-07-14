package codex

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateTrustRuntimeKeepsCodexHomeAndCanonicalSQLite(t *testing.T) {
	home := t.TempDir()
	cache := filepath.Join(home, ".cache")
	codexHome := filepath.Join(home, ".codex")
	workdir := filepath.Join(home, "work")

	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("CODEX_HOME", "")

	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workdir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(workdir)
	for name, content := range map[string]string{
		"auth.json":   "{}\n",
		"config.toml": "model = \"gpt-5.5\"\n",
	} {
		if err := os.WriteFile(filepath.Join(codexHome, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	env, args, cleanup, err := CreateTrustRuntimeForArgs("catppuccin-frappe-pink", []string{"hello"})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	if !contains(env, "CODEX_HOME="+codexHome) {
		t.Fatalf("runtime env should preserve real Codex home, got %#v", env)
	}
	if !contains(env, "CODEX_SQLITE_HOME="+codexHome) {
		t.Fatalf("runtime env should use canonical Codex SQLite home, got %#v", env)
	}
	if _, err := os.Stat(filepath.Join(cache, "terminal-theme-run/codex/runtime")); !os.IsNotExist(err) {
		t.Fatalf("runtime should not create per-worktree SQLite state: %v", err)
	}
	for _, want := range []string{
		"tui.theme=\"catppuccin-frappe-pink\"",
		"-C",
		workdir,
		projectsTrustOverride([]string{workdir}),
	} {
		if !contains(args, want) {
			t.Fatalf("args should contain %q, got %#v", want, args)
		}
	}
	if args[len(args)-1] != "hello" {
		t.Fatalf("user args should be preserved after wrapper config, got %#v", args)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "terminal-theme-run.config.toml")); !os.IsNotExist(err) {
		t.Fatalf("runtime should not create a Codex profile file: %v", err)
	}

	_, doctorArgs, doctorCleanup, err := CreateTrustRuntimeForArgs("catppuccin-frappe-pink", []string{"doctor"})
	if err != nil {
		t.Fatal(err)
	}
	defer doctorCleanup()
	if contains(doctorArgs, "-p") || contains(doctorArgs, "--profile") {
		t.Fatalf("doctor should not receive profile args, got %#v", doctorArgs)
	}
	if contains(doctorArgs, "approval_policy=\"never\"") || contains(doctorArgs, "sandbox_mode=\"danger-full-access\"") {
		t.Fatalf("doctor should not receive static policy config owned by dot_codex, got %#v", doctorArgs)
	}
	if !contains(doctorArgs, projectsTrustOverride([]string{workdir})) {
		t.Fatalf("doctor should still receive trust as a config override, got %#v", doctorArgs)
	}
}

func TestCreateTrustRuntimeTrustsGitRootAndExplicitCwd(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	home := t.TempDir()
	repo := filepath.Join(home, "repo")
	subdir := filepath.Join(repo, "nested")
	other := filepath.Join(home, "other")

	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	for _, dir := range []string{subdir, other} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repo, "init")
	t.Chdir(subdir)
	gitRoot := runGitOutput(t, subdir, "rev-parse", "--show-toplevel")

	_, args, cleanup, err := CreateTrustRuntimeForArgs("catppuccin-frappe-pink", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	for _, want := range []string{
		"-C",
		subdir,
		projectsTrustOverride([]string{subdir, gitRoot}),
	} {
		if !contains(args, want) {
			t.Fatalf("args should contain %q, got %#v", want, args)
		}
	}

	_, explicitArgs, explicitCleanup, err := CreateTrustRuntimeForArgs("catppuccin-frappe-pink", []string{"--cd", other})
	if err != nil {
		t.Fatal(err)
	}
	defer explicitCleanup()
	if contains(explicitArgs, "-C") {
		t.Fatalf("wrapper should not add duplicate -C when user provides --cd, got %#v", explicitArgs)
	}
	if !contains(explicitArgs, projectsTrustOverride([]string{other})) {
		t.Fatalf("explicit --cd target should be trusted, got %#v", explicitArgs)
	}
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func runGitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v failed: %v", args, err)
	}
	return strings.TrimSpace(string(output))
}
