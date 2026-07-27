#include "test-support.h"

#include "theme.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>

static TtrManifest *test_manifest;

static bool prepare_integration(const char *name, char *const *extra_args,
                                TtrPreparedArgs *prepared, GError **error) {
  const TtrIntegration *integration =
      ttr_manifest_find_integration(test_manifest, name);
  g_assert_nonnull(integration);
  return ttr_prepare_integration(integration, ttr_manifest_runtime(test_manifest),
                                 extra_args, prepared, error);
}

static void test_argument_theme(void) {
  char *extra[] = {
      TTR_MUTABLE_STRING("continue"),
      TTR_MUTABLE_STRING("--recent"),
      nullptr,
  };
  g_setenv("TERMINAL_THEME", "dark", true);
  GError *error = nullptr;
  TtrPreparedArgs prepared;
  g_assert_true(prepare_integration("argument-theme", extra, &prepared, &error));
  g_assert_no_error(error);
  g_assert_cmpstr(prepared.argv[0], ==, "--appearance");
  g_assert_cmpstr(prepared.argv[1], ==, "night");
  g_assert_cmpstr(prepared.argv[2], ==, "--access");
  g_assert_true(g_str_has_prefix(prepared.argv[3], "workspaces={"));
  g_assert_cmpstr(prepared.argv[4], ==, "continue");
  g_assert_cmpstr(prepared.argv[5], ==, "--recent");
  g_assert_null(prepared.argv[6]);
  ttr_prepared_args_clear(&prepared);
  g_unsetenv("TERMINAL_THEME");
}

static void test_integration_registry(void) {
  char *extra[] = {TTR_MUTABLE_STRING("--flag"), nullptr};
  GError *error = nullptr;
  TtrPreparedArgs prepared;
  g_assert_true(ttr_prepare_integration(nullptr, ttr_manifest_runtime(test_manifest),
                                        extra, &prepared, &error));
  g_assert_no_error(error);
  const char *const expected[] = {"--flag", nullptr};
  ttr_assert_strv_equal(prepared.argv, expected);
  ttr_prepared_args_clear(&prepared);

  g_assert_null(ttr_manifest_find_integration(test_manifest, "not-registered"));

  TtrIntegration invalid = {
      .name = TTR_MUTABLE_STRING("invalid"),
  };
  g_assert_false(ttr_prepare_integration(&invalid, ttr_manifest_runtime(test_manifest),
                                         extra, &prepared, &error));
  g_assert_error(error, g_quark_from_static_string("terminal-theme-run-theme-error"),
                 1);
  g_assert_nonnull(strstr(error->message, "has no validated strategy"));
  g_clear_error(&error);
}

static void test_cached_config_theme(void) {
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-cache-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *cache = g_build_filename(temporary, "cache", nullptr);
  char *config = g_build_filename(temporary, "monitor.conf", nullptr);
  g_assert_true(
      g_file_set_contents(config, "enabled = true\npalette = \"old\"\n", -1, &error));
  g_assert_no_error(error);
  g_setenv("HOME", temporary, true);
  g_setenv("XDG_CACHE_HOME", cache, true);

  char *extra[] = {
      TTR_MUTABLE_STRING("--settings"),
      config,
      TTR_MUTABLE_STRING("--unicode"),
      nullptr,
  };
  TtrPreparedArgs prepared;
  g_setenv("TERMINAL_THEME", "light", true);
  g_assert_true(prepare_integration("cached-config", extra, &prepared, &error));
  g_assert_no_error(error);
  g_assert_cmpstr(prepared.argv[0], ==, "--settings");
  g_assert_cmpstr(prepared.argv[2], ==, "--unicode");
  g_assert_null(prepared.argv[3]);
  char *contents = nullptr;
  g_assert_true(g_file_get_contents(prepared.argv[1], &contents, nullptr, &error));
  g_assert_no_error(error);
  g_assert_nonnull(strstr(contents, "palette = \"day\""));
  g_assert_null(strstr(contents, "\"old\""));
  g_free(contents);
  ttr_prepared_args_clear(&prepared);
  g_unsetenv("TERMINAL_THEME");

  g_remove(config);
  char *cache_leaf =
      g_build_filename(cache, "terminal-theme-run", "cache-test", nullptr);
  g_rmdir(cache_leaf);
  g_free(cache_leaf);
  char *cache_parent = g_build_filename(cache, "terminal-theme-run", nullptr);
  g_rmdir(cache_parent);
  g_free(cache_parent);
  g_rmdir(cache);
  g_rmdir(temporary);
  g_free(config);
  g_free(cache);
  g_free(temporary);
}

static void test_validated_config_theme(void) {
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-validation-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *config = g_build_filename(temporary, "config.toml", nullptr);
  g_assert_true(g_file_set_contents(
      config, "\"appearance\" = \"old\"\n[view]\nline_numbers = \"relative\"\n", -1,
      &error));
  g_assert_no_error(error);
  g_setenv("HOME", temporary, true);

  char *joined = g_strdup_printf("-s=%s", config);
  char *extra[] = {joined, TTR_MUTABLE_STRING("README.md"), nullptr};
  TtrPreparedArgs prepared;
  g_setenv("TERMINAL_THEME", "dark", true);
  g_assert_true(prepare_integration("validated-config", extra, &prepared, &error));
  g_assert_no_error(error);
  g_assert_cmpstr(prepared.argv[0], ==, "--settings");
  g_assert_cmpstr(prepared.argv[2], ==, "README.md");
  g_assert_null(prepared.argv[3]);
  char *contents = nullptr;
  g_assert_true(g_file_get_contents(prepared.argv[1], &contents, nullptr, &error));
  g_assert_no_error(error);
  g_assert_nonnull(strstr(contents, "appearance = 'night'"));
  g_assert_nonnull(strstr(contents, "line_numbers = \"relative\""));
  g_assert_null(strstr(contents, "\"old\""));
  g_free(contents);
  ttr_prepared_args_clear(&prepared);

  g_assert_true(g_file_set_contents(config, "appearance = [\"not\", \"a string\"]\n",
                                    -1, &error));
  g_assert_no_error(error);
  g_assert_false(prepare_integration("validated-config", extra, &prepared, &error));
  g_assert_error(error, g_quark_from_static_string("terminal-theme-run-theme-error"),
                 1);
  g_assert_nonnull(strstr(error->message, "appearance must be a string"));
  g_clear_error(&error);
  g_unsetenv("TERMINAL_THEME");

  g_free(joined);
  g_remove(config);
  g_rmdir(temporary);
  g_free(config);
  g_free(temporary);
}

static void test_validated_config_table_theme(void) {
  GError *error = nullptr;
  char *temporary =
      g_dir_make_tmp("terminal-theme-run-table-theme-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *config = g_build_filename(temporary, "config.toml", nullptr);
  g_assert_true(g_file_set_contents(config,
                                    "[appearance]\n"
                                    "dark = \"night\"\n"
                                    "light = \"day\"\n"
                                    "fallback = \"night\"\n"
                                    "\n"
                                    "[view]\n"
                                    "line_numbers = \"relative\"\n",
                                    -1, &error));
  g_assert_no_error(error);
  g_setenv("HOME", temporary, true);
  g_setenv("TERMINAL_THEME", "light", true);

  char *extra[] = {
      TTR_MUTABLE_STRING("--settings"),
      config,
      nullptr,
  };
  TtrPreparedArgs prepared;
  g_assert_true(prepare_integration("validated-config", extra, &prepared, &error));
  g_assert_no_error(error);

  char *contents = nullptr;
  g_assert_true(g_file_get_contents(prepared.argv[1], &contents, nullptr, &error));
  g_assert_no_error(error);
  g_assert_nonnull(strstr(contents, "appearance = 'day'"));
  g_assert_null(strstr(contents, "[appearance]"));
  g_assert_null(strstr(contents, "fallback = \"night\""));
  g_assert_nonnull(strstr(contents, "[view]\nline_numbers = \"relative\""));
  g_free(contents);
  ttr_prepared_args_clear(&prepared);
  g_unsetenv("TERMINAL_THEME");

  g_remove(config);
  g_rmdir(temporary);
  g_free(config);
  g_free(temporary);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  GError *error = nullptr;
  test_manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  g_assert_nonnull(test_manifest);
  g_test_add_func("/theme/arguments", test_argument_theme);
  g_test_add_func("/theme/integration-registry", test_integration_registry);
  g_test_add_func("/theme/config-cache", test_cached_config_theme);
  g_test_add_func("/theme/config-validation", test_validated_config_theme);
  g_test_add_func("/theme/config-table", test_validated_config_table_theme);
  const int status = g_test_run();
  ttr_manifest_free(test_manifest);
  return status;
}
