#include "support/test-support.h"

#include "config/manifest.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>

static void test_default_manifest(void) {
  GError *error = nullptr;
  char *home = g_dir_make_tmp("terminal-theme-run-manifest-test-XXXXXX", &error);
  g_assert_no_error(error);
  g_setenv("HOME", home, true);
  g_unsetenv("TERMINAL_THEME_RUN_CONFIG");
  g_unsetenv("XDG_CONFIG_HOME");
  TtrManifest *manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  g_assert_nonnull(manifest);
  char **names = ttr_manifest_program_names(manifest);
  g_assert_nonnull(names[0]);
  for (size_t index = 0; names[index] != nullptr; index++) {
    const TtrRunner *runner = ttr_manifest_find(manifest, names[index]);
    g_assert_nonnull(runner);
    if (*runner->integration != '\0') {
      g_assert_nonnull(ttr_manifest_find_integration(manifest, runner->integration));
    }
  }
  const TtrRunner *helix = ttr_manifest_find(manifest, "helix");
  g_assert_nonnull(helix);
  g_assert_cmpstr(helix->integration, ==, "");
  const TtrRuntimeConfig *runtime = ttr_manifest_runtime(manifest);
  g_assert_nonnull(runtime);
  g_assert_cmpstr(runtime->theme_environment[0], ==, "COLOR_SCHEME");
  g_assert_cmpstr(g_hash_table_lookup(runtime->theme_terminal_queries, "ghostty"), ==,
                  "color-scheme");
  g_assert_cmpstr(g_hash_table_lookup(runtime->theme_terminal_queries, "xterm-ghostty"),
                  ==, "color-scheme");
  g_assert_cmpstr(g_hash_table_lookup(runtime->theme_terminal_queries, "kitty"), ==,
                  "color-scheme");
  g_assert_cmpstr(g_hash_table_lookup(runtime->theme_terminal_queries, "xterm-kitty"),
                  ==, "color-scheme");
  g_assert_cmpint(runtime->theme_probe_timeout_ms, ==, 100);
  g_assert_cmpint(runtime->theme_macos_fallback_mode, ==, TTR_THEME_DARK);
  g_assert_cmpint(runtime->theme_unix_fallback_mode, ==, TTR_THEME_DARK);
  const TtrIntegration *codex = ttr_manifest_find_integration(manifest, "codex");
  const TtrIntegration *btop = ttr_manifest_find_integration(manifest, "btop");
  g_assert_nonnull(codex);
  g_assert_nonnull(btop);
  g_assert_cmpint(codex->strategy_kind, ==, TTR_INTEGRATION_STRATEGY_ARGUMENTS);
  g_assert_cmpint(btop->strategy_kind, ==, TTR_INTEGRATION_STRATEGY_CONFIG);
  g_assert_cmpint(btop->temporary_location_kind, ==, TTR_TEMPORARY_LOCATION_CACHE);
  g_assert_cmpint(btop->validation_kind, ==, TTR_CONFIG_VALIDATION_NONE);
  g_assert_cmpint(btop->quote_character, ==, '"');
  g_strfreev(names);
  ttr_manifest_free(manifest);
  g_rmdir(home);
  g_free(home);
}

static void test_manifest_override_replaces_runner(void) {
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-override-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *config = g_build_filename(temporary, "runners.toml", nullptr);
  g_unsetenv("TERMINAL_THEME_RUN_CONFIG");
  TtrManifest *defaults = ttr_manifest_load(&error);
  g_assert_no_error(error);
  g_assert_nonnull(defaults);
  char **default_names = ttr_manifest_program_names(defaults);
  g_assert_nonnull(default_names[0]);
  char *replaced_name = g_strdup(default_names[0]);
  g_strfreev(default_names);
  ttr_manifest_free(defaults);

  char *override = g_strdup_printf("[[runner]]\n"
                                   "name = \"%s\"\n"
                                   "programs = [\"/usr/bin/true\"]\n"
                                   "skip_env = [\"CUSTOM_SKIP\"]\n"
                                   "default_args = [\"--quiet\"]\n"
                                   "env = { COLOR = \"always\" }\n"
                                   "env_unset = [\"NO_COLOR\", \"TERM\"]\n"
                                   "\n"
                                   "[[runner]]\n"
                                   "name = \"custom\"\n"
                                   "programs = [\"/usr/bin/false\"]\n",
                                   replaced_name);
  g_assert_true(g_file_set_contents(config, override, -1, &error));
  g_assert_no_error(error);
  g_setenv("TERMINAL_THEME_RUN_CONFIG", config, true);

  TtrManifest *manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  const TtrRunner *replaced = ttr_manifest_find(manifest, replaced_name);
  g_assert_nonnull(replaced);
  const char *const programs[] = {"/usr/bin/true", nullptr};
  const char *const skip_env[] = {"CUSTOM_SKIP", nullptr};
  const char *const default_args[] = {"--quiet", nullptr};
  const char *const env_unset[] = {"NO_COLOR", "TERM", nullptr};
  ttr_assert_strv_equal(replaced->programs, programs);
  ttr_assert_strv_equal(replaced->skip_env, skip_env);
  ttr_assert_strv_equal(replaced->default_args, default_args);
  g_assert_cmpuint(g_hash_table_size(replaced->env), ==, 1);
  g_assert_cmpstr(g_hash_table_lookup(replaced->env, "COLOR"), ==, "always");
  ttr_assert_strv_equal(replaced->env_unset, env_unset);
  g_assert_cmpstr(replaced->integration, ==, "");
  const TtrRunner *custom = ttr_manifest_find(manifest, "custom");
  g_assert_nonnull(custom);
  g_assert_null(custom->default_args[0]);
  g_assert_cmpuint(g_hash_table_size(custom->env), ==, 0);
  g_assert_cmpstr(custom->integration, ==, "");
  ttr_manifest_free(manifest);

  g_unsetenv("TERMINAL_THEME_RUN_CONFIG");
  g_free(override);
  g_free(replaced_name);
  g_remove(config);
  g_rmdir(temporary);
  g_free(config);
  g_free(temporary);
}

static void test_runtime_data_directory_override(void) {
  g_autofree char *original_data_directory =
      g_strdup(g_getenv("TERMINAL_THEME_RUN_DATA_DIR"));
  g_assert_nonnull(original_data_directory);
  g_autoptr(GError) error = nullptr;
  g_autofree char *temporary =
      g_dir_make_tmp("terminal-theme-run-data-test-XXXXXX", &error);
  g_assert_no_error(error);

  static const char *const names[] = {
      "runners.toml",
      "integrations.toml",
      "runtime-defaults.toml",
      nullptr,
  };
  for (size_t index = 0; names[index] != nullptr; index++) {
    g_autofree char *source =
        g_build_filename(original_data_directory, names[index], nullptr);
    g_autofree char *destination = g_build_filename(temporary, names[index], nullptr);
    g_autofree char *contents = nullptr;
    g_assert_true(g_file_get_contents(source, &contents, nullptr, &error));
    g_assert_no_error(error);
    if (g_str_equal(names[index], "runtime-defaults.toml")) {
      g_autoptr(GString) edited = g_string_new(contents);
      g_assert_cmpuint(g_string_replace(edited, "theme_probe_timeout_ms = 100",
                                        "theme_probe_timeout_ms = 321", 1),
                       ==, 1);
      g_free(contents);
      contents = g_string_free_and_steal(g_steal_pointer(&edited));
    }
    g_assert_true(g_file_set_contents(destination, contents, -1, &error));
    g_assert_no_error(error);
  }

  g_setenv("TERMINAL_THEME_RUN_DATA_DIR", temporary, true);
  g_autoptr(TtrManifest) manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  g_assert_nonnull(manifest);
  g_assert_cmpint(ttr_manifest_runtime(manifest)->theme_probe_timeout_ms, ==, 321);
  g_setenv("TERMINAL_THEME_RUN_DATA_DIR", original_data_directory, true);

  for (size_t index = 0; names[index] != nullptr; index++) {
    g_autofree char *path = g_build_filename(temporary, names[index], nullptr);
    g_assert_cmpint(g_remove(path), ==, 0);
  }
  g_assert_cmpint(g_rmdir(temporary), ==, 0);
}

static void test_manifest_rejects_invalid_schema(void) {
  GError *error = nullptr;
  char *temporary = g_dir_make_tmp("terminal-theme-run-schema-test-XXXXXX", &error);
  g_assert_no_error(error);
  char *config = g_build_filename(temporary, "runners.toml", nullptr);
  static constexpr char legacy_environment[] = "[[runner]]\n"
                                               "name = \"legacy\"\n"
                                               "env = [\"COLOR=always\"]\n";
  g_assert_true(g_file_set_contents(config, legacy_environment, -1, &error));
  g_assert_no_error(error);
  g_setenv("TERMINAL_THEME_RUN_CONFIG", config, true);

  TtrManifest *manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  const TtrRunner *legacy = ttr_manifest_find(manifest, "legacy");
  g_assert_nonnull(legacy);
  g_assert_cmpstr(g_hash_table_lookup(legacy->env, "COLOR"), ==, "always");
  ttr_manifest_free(manifest);

  static constexpr char invalid_environment[] = "[[runner]]\n"
                                                "name = \"invalid\"\n"
                                                "env = [\"missing-separator\"]\n";
  g_assert_true(g_file_set_contents(config, invalid_environment, -1, &error));
  g_assert_no_error(error);
  manifest = ttr_manifest_load(&error);
  g_assert_null(manifest);
  g_assert_error(error,
                 g_quark_from_static_string("terminal-theme-run-toml-schema-error"), 1);
  g_assert_nonnull(strstr(error->message, "invalid environment assignment"));
  g_clear_error(&error);

  static constexpr char missing_name[] = "[[runner]]\nprograms = [\"true\"]\n";
  g_assert_true(g_file_set_contents(config, missing_name, -1, &error));
  g_assert_no_error(error);
  manifest = ttr_manifest_load(&error);
  g_assert_null(manifest);
  g_assert_nonnull(strstr(error->message, "required field name is missing"));
  g_clear_error(&error);

  static constexpr char unknown_field[] = "[[runner]]\n"
                                          "name = \"typo\"\n"
                                          "defualt_args = [\"--quiet\"]\n";
  g_assert_true(g_file_set_contents(config, unknown_field, -1, &error));
  g_assert_no_error(error);
  manifest = ttr_manifest_load(&error);
  g_assert_null(manifest);
  g_assert_nonnull(strstr(error->message, "unknown field defualt_args"));
  g_clear_error(&error);

  static constexpr char missing_integration[] = "[[runner]]\n"
                                                "name = \"orphan\"\n"
                                                "integration = \"missing\"\n";
  g_assert_true(g_file_set_contents(config, missing_integration, -1, &error));
  g_assert_no_error(error);
  manifest = ttr_manifest_load(&error);
  g_assert_null(manifest);
  g_assert_nonnull(strstr(error->message, "references unknown integration missing"));
  g_clear_error(&error);

  static constexpr char unknown_strategy[] = "[[integration]]\n"
                                             "name = \"unsupported\"\n"
                                             "strategy = \"plugin\"\n"
                                             "dark_theme = \"night\"\n"
                                             "light_theme = \"day\"\n";
  g_assert_true(g_file_set_contents(config, unknown_strategy, -1, &error));
  g_assert_no_error(error);
  manifest = ttr_manifest_load(&error);
  g_assert_null(manifest);
  g_assert_nonnull(strstr(error->message, "unsupported strategy plugin"));
  g_clear_error(&error);

  static const struct {
    const char *config_flags;
    const char *temporary_prefix;
    const char *message;
  } invalid_config_integrations[] = {
      {
          .config_flags = "\"\"",
          .temporary_prefix = "safe-XXXXXX",
          .message = "config_flags must not contain an empty flag",
      },
      {
          .config_flags = "\"--config\"",
          .temporary_prefix = "../escape-XXXXXX",
          .message = "temporary_prefix must be a file name",
      },
  };
  for (size_t index = 0; index < G_N_ELEMENTS(invalid_config_integrations); index++) {
    g_autofree char *invalid_config =
        g_strdup_printf("[[integration]]\n"
                        "name = \"invalid-config\"\n"
                        "strategy = \"config\"\n"
                        "dark_theme = \"night\"\n"
                        "light_theme = \"day\"\n"
                        "default_config = \".config/application\"\n"
                        "assignment = \"theme\"\n"
                        "config_flags = [%s]\n"
                        "config_output_flag = \"--config\"\n"
                        "temporary_prefix = \"%s\"\n"
                        "temporary_location = \"system\"\n"
                        "quote = \"'\"\n",
                        invalid_config_integrations[index].config_flags,
                        invalid_config_integrations[index].temporary_prefix);
    g_assert_true(g_file_set_contents(config, invalid_config, -1, &error));
    g_assert_no_error(error);
    manifest = ttr_manifest_load(&error);
    g_assert_null(manifest);
    g_assert_nonnull(
        strstr(error->message, invalid_config_integrations[index].message));
    g_clear_error(&error);
  }

  g_unsetenv("TERMINAL_THEME_RUN_CONFIG");
  g_remove(config);
  g_rmdir(temporary);
  g_free(config);
  g_free(temporary);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  g_test_add_func("/manifest/default", test_default_manifest);
  g_test_add_func("/manifest/override", test_manifest_override_replaces_runner);
  g_test_add_func("/manifest/runtime-data", test_runtime_data_directory_override);
  g_test_add_func("/manifest/invalid-schema", test_manifest_rejects_invalid_schema);
  return g_test_run();
}
