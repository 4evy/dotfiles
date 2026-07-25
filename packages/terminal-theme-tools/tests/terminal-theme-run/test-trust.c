#include "test-support.h"

#include "trust.h"

#include <git2.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>
#include <tomlc17.h>

static void test_resolve_launch_cwd(void) {
  char *cwd_flags[] = {
      TTR_MUTABLE_STRING("-C"),
      TTR_MUTABLE_STRING("--cd"),
      nullptr,
  };
  char *cwd_prefixes[] = {
      TTR_MUTABLE_STRING("-C"),
      TTR_MUTABLE_STRING("--cd="),
      nullptr,
  };
  char *original = g_get_current_dir();
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-cwd-test-XXXXXX", &error);
  g_assert_no_error(error);
  g_assert_cmpint(g_chdir(temporary), ==, 0);
  char *current = g_get_current_dir();

  char *relative[] = {
      TTR_MUTABLE_STRING("--cd"),
      TTR_MUTABLE_STRING("nested/../work"),
      nullptr,
  };
  char *resolved = ttr_resolve_launch_cwd(relative, cwd_flags, cwd_prefixes);
  char *expected = g_build_filename(current, "work", nullptr);
  g_assert_cmpstr(resolved, ==, expected);
  g_free(resolved);
  g_free(expected);

  char *separated[] = {
      TTR_MUTABLE_STRING("--"),
      TTR_MUTABLE_STRING("-C"),
      TTR_MUTABLE_STRING("/tmp/prompt"),
      nullptr,
  };
  resolved = ttr_resolve_launch_cwd(separated, cwd_flags, cwd_prefixes);
  g_assert_cmpstr(resolved, ==, current);
  g_free(resolved);

  g_assert_cmpint(g_chdir(original), ==, 0);
  g_rmdir(temporary);
  g_free(current);
  g_free(temporary);
  g_free(original);
}

static void test_worktree_trust_override_is_toml(void) {
  char *empty[] = {nullptr};
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-git-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *repository = g_build_filename(temporary, "repo", nullptr);
  char *nested = g_build_filename(repository, "nested", nullptr);
  g_assert_cmpint(git_libgit2_init(), >, 0);
  git_repository *initialized = nullptr;
  g_assert_cmpint(git_repository_init(&initialized, repository, false), ==, 0);
  git_repository_free(initialized);
  g_assert_cmpint(git_libgit2_shutdown(), ==, 0);
  g_assert_cmpint(g_mkdir(nested, 0755), ==, 0);

  char *original = g_get_current_dir();
  g_assert_cmpint(g_chdir(nested), ==, 0);
  char *override = ttr_toml_worktree_trust_override("workspaces", "access", "allowed",
                                                    nullptr, empty, empty);
  g_assert_no_error(error);
  char *current = g_get_current_dir();
  char *current_root = g_path_get_dirname(current);
  toml_result_t parsed = toml_parse(override, (int)strlen(override));
  g_assert_true(parsed.ok);
  toml_datum_t workspaces = toml_get(parsed.toptab, "workspaces");
  g_assert_cmpint(workspaces.type, ==, TOML_TABLE);
  const char *const targets[] = {current, current_root, nullptr};
  for (size_t index = 0; targets[index] != nullptr; index++) {
    toml_datum_t workspace = toml_get(workspaces, targets[index]);
    g_assert_cmpint(workspace.type, ==, TOML_TABLE);
    toml_datum_t access = toml_get(workspace, "access");
    g_assert_cmpint(access.type, ==, TOML_STRING);
    g_assert_cmpstr(access.u.s, ==, "allowed");
  }
  toml_free(parsed);
  g_free(override);
  g_assert_cmpint(g_chdir(original), ==, 0);

  g_free(current);
  g_free(current_root);
  g_free(original);
  g_free(nested);
  g_free(repository);
  g_free(temporary);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  g_test_add_func("/trust/cwd", test_resolve_launch_cwd);
  g_test_add_func("/trust/toml-worktree", test_worktree_trust_override_is_toml);
  return g_test_run();
}
