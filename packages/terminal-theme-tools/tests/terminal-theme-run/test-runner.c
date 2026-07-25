#include "runner.h"

#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>

static TtrManifest *test_manifest;

static void test_runner_propagates_exit_and_environment(void) {
  char runner_name[] = "sh";
  char integration[] = "";
  char shell[] = "/bin/sh";
  char default_flag[] = "-c";
  char unset_environment[] = "TTR_CHILD_UNSET";
  char *programs[] = {shell, nullptr};
  char *skip_env[] = {nullptr};
  char *default_args[] = {default_flag, nullptr};
  g_autoptr(GHashTable) environment =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  g_hash_table_insert(environment, g_strdup("TTR_CHILD_SET"), g_strdup("yes"));
  char *environment_unset[] = {unset_environment, nullptr};
  TtrRunner runner = {
      .name = runner_name,
      .programs = programs,
      .skip_env = skip_env,
      .default_args = default_args,
      .env = environment,
      .env_unset = environment_unset,
      .integration = integration,
  };
  g_setenv("TTR_CHILD_UNSET", "parent", true);
  char command[] = "test \"$TTR_CHILD_SET\" = yes && "
                   "test -z \"${TTR_CHILD_UNSET+x}\" && exit 23";
  char *arguments[] = {command, nullptr};
  GError *error = nullptr;
  g_assert_cmpint(ttr_runner_run(&runner, nullptr, ttr_manifest_runtime(test_manifest),
                                 arguments, &error),
                  ==, 23);
  g_assert_no_error(error);
  g_unsetenv("TTR_CHILD_UNSET");
}

static void test_runner_skips_same_executable_through_symlink(void) {
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-skip-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *wrapper = g_build_filename(temporary, "wrapper", nullptr);
  char *fallback = g_build_filename(temporary, "fallback", nullptr);
  g_autoptr(GFile) wrapper_file = g_file_new_for_path(wrapper);
  g_assert_true(g_file_make_symbolic_link(wrapper_file, "/bin/sh", nullptr, &error));
  g_assert_no_error(error);
  g_assert_true(g_file_set_contents(fallback, "#!/bin/sh\nexit 29\n", -1, &error));
  g_assert_no_error(error);
  g_assert_cmpint(g_chmod(fallback, 0700), ==, 0);

  char runner_name[] = "skip-test";
  char skip_name[] = "TTR_SKIP_TEST";
  char integration[] = "";
  char *programs[] = {wrapper, fallback, nullptr};
  char *skip_env[] = {skip_name, nullptr};
  char *empty[] = {nullptr};
  g_autoptr(GHashTable) environment =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  TtrRunner runner = {
      .name = runner_name,
      .programs = programs,
      .skip_env = skip_env,
      .default_args = empty,
      .env = environment,
      .env_unset = empty,
      .integration = integration,
  };
  g_setenv(skip_name, "/bin/sh", true);
  g_assert_cmpint(ttr_runner_run(&runner, nullptr, ttr_manifest_runtime(test_manifest),
                                 nullptr, &error),
                  ==, 29);
  g_assert_no_error(error);
  g_unsetenv(skip_name);

  g_remove(wrapper);
  g_remove(fallback);
  g_rmdir(temporary);
  g_free(fallback);
  g_free(wrapper);
  g_free(temporary);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  GError *error = nullptr;
  test_manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  g_assert_nonnull(test_manifest);
  g_test_add_func("/runner/exit-and-environment",
                  test_runner_propagates_exit_and_environment);
  g_test_add_func("/runner/skip-symlink",
                  test_runner_skips_same_executable_through_symlink);
  const int status = g_test_run();
  ttr_manifest_free(test_manifest);
  return status;
}
