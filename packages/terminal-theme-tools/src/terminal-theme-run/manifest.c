#include "manifest.h"

#include "toml-schema.h"
#include "util.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

static constexpr unsigned char default_runner_data[] = {
#embed "../../data/terminal-theme-run/runners.toml" suffix(, 0) if_empty(0)
};

static constexpr unsigned char default_integration_data[] = {
#embed "../../data/terminal-theme-run/integrations.toml" suffix(, 0) if_empty(0)
};

static constexpr unsigned char default_runtime_data[] = {
#embed "../../data/terminal-theme-run/runtime-defaults.toml" suffix(, 0) if_empty(0)
};

#define TTR_SCHEMA_FIELD(record_type, member, field_type, is_required)                 \
  {                                                                                    \
      .key = #member,                                                                  \
      .offset = G_STRUCT_OFFSET(record_type, member),                                  \
      .type = TTR_TOML_FIELD_##field_type,                                             \
      .required = (is_required),                                                       \
  },

static const TtrTomlField runner_fields[] = {
#define TTR_RUNNER_FIELD(member, field_type, is_required)                              \
  TTR_SCHEMA_FIELD(TtrRunner, member, field_type, is_required)
#include "runner-fields.def"
#undef TTR_RUNNER_FIELD
};

static const TtrTomlField integration_fields[] = {
#define TTR_INTEGRATION_FIELD(member, field_type, is_required)                         \
  TTR_SCHEMA_FIELD(TtrIntegration, member, field_type, is_required)
#include "integration-fields.def"
#undef TTR_INTEGRATION_FIELD
};

static const TtrTomlField runtime_fields[] = {
#define TTR_RUNTIME_FIELD(member, field_type, is_required)                             \
  TTR_SCHEMA_FIELD(TtrRuntimeConfig, member, field_type, is_required)
#include "runtime-fields.def"
#undef TTR_RUNTIME_FIELD
};

#undef TTR_SCHEMA_FIELD

typedef struct {
  char *name;
} NamedConfig;

typedef gpointer (*TableLoader)(toml_datum_t table, GError **error);

typedef struct {
  GHashTable *runners;
  GHashTable *integrations;
} ManifestFragment;

typedef bool (*IntegrationValidator)(const TtrIntegration *integration, GError **error);

typedef struct {
  TtrIntegrationStrategy kind;
  const char *name;
  IntegrationValidator validate;
} IntegrationStrategy;

static GQuark manifest_error_quark(void) {
  return g_quark_from_static_string("terminal-theme-run-manifest-error");
}

static void runner_free(gpointer data) {
  TtrRunner *runner = data;
  if (runner == nullptr) {
    return;
  }
  ttr_toml_clear_fields(runner, runner_fields, G_N_ELEMENTS(runner_fields));
  g_free(runner);
}

static void integration_free(gpointer data) {
  TtrIntegration *integration = data;
  if (integration == nullptr) {
    return;
  }
  ttr_toml_clear_fields(integration, integration_fields,
                        G_N_ELEMENTS(integration_fields));
  g_free(integration);
}

static bool environment_name_is_valid(const char *name) {
  return ttr_string_is_set(name) && strchr(name, '=') == nullptr;
}

static bool environment_names_are_valid(const TtrRunner *runner, const char *field_name,
                                        char *const *names, GError **error) {
  for (size_t index = 0; names[index] != nullptr; index++) {
    if (!environment_name_is_valid(names[index])) {
      g_set_error(error, manifest_error_quark(), 1, "runner %s has an invalid %s name",
                  runner->name, field_name);
      return false;
    }
  }
  return true;
}

static bool runner_is_valid(const TtrRunner *runner, GError **error) {
  if (!ttr_string_is_set(runner->name)) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "runner field name must not be empty");
    return false;
  }
  if (!environment_names_are_valid(runner, "skip_env", runner->skip_env, error) ||
      !environment_names_are_valid(runner, "env_unset", runner->env_unset, error)) {
    return false;
  }
  for (size_t index = 0; runner->programs[index] != nullptr; index++) {
    if (g_str_equal(runner->programs[index], "$")) {
      g_set_error(error, manifest_error_quark(), 1,
                  "runner %s has an invalid environment program reference",
                  runner->name);
      return false;
    }
  }
  GHashTableIter iterator;
  gpointer name = nullptr;
  g_hash_table_iter_init(&iterator, runner->env);
  while (g_hash_table_iter_next(&iterator, &name, nullptr)) {
    if (!environment_name_is_valid(name)) {
      g_set_error(error, manifest_error_quark(), 1, "runner %s has an invalid env name",
                  runner->name);
      return false;
    }
  }
  return true;
}

static bool templates_contain(char *const *templates, const char *placeholder) {
  for (size_t index = 0; templates[index] != nullptr; index++) {
    if (strstr(templates[index], placeholder) != nullptr) {
      return true;
    }
  }
  return false;
}

static bool require_integration_field(const TtrIntegration *integration,
                                      const char *field_name, const char *value,
                                      GError **error) {
  if (ttr_string_is_set(value)) {
    return true;
  }
  g_set_error(error, manifest_error_quark(), 1,
              "integration %s strategy %s requires field %s", integration->name,
              integration->strategy, field_name);
  return false;
}

static bool argument_integration_is_valid(const TtrIntegration *integration,
                                          GError **error) {
  if (integration->arguments[0] == nullptr) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s strategy arguments requires field arguments",
                integration->name);
    return false;
  }
  if (!templates_contain(integration->arguments, "{theme}")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s arguments do not contain {theme}", integration->name);
    return false;
  }

  const bool has_table = ttr_string_is_set(integration->trust_table);
  const bool has_field = ttr_string_is_set(integration->trust_field);
  const bool has_value = ttr_string_is_set(integration->trust_value);
  const bool has_cwd_flags = integration->trust_cwd_flags[0] != nullptr ||
                             integration->trust_cwd_prefixes[0] != nullptr;
  if (has_table != has_field || has_field != has_value) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s must set trust_table, trust_field, and trust_value "
                "together",
                integration->name);
    return false;
  }
  if (has_table && !templates_contain(integration->arguments, "{trust}")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s arguments do not contain {trust}", integration->name);
    return false;
  }
  if (has_table != has_cwd_flags) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s must set trust cwd flags together with trust fields",
                integration->name);
    return false;
  }
  if (ttr_strv_contains(integration->trust_cwd_flags, "") ||
      ttr_strv_contains(integration->trust_cwd_prefixes, "")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s trust cwd flags must not be empty", integration->name);
    return false;
  }
  return true;
}

static bool config_integration_is_valid(const TtrIntegration *integration,
                                        GError **error) {
  const struct {
    const char *name;
    const char *value;
  } required_fields[] = {
      {"default_config", integration->default_config},
      {"assignment", integration->assignment},
      {"config_output_flag", integration->config_output_flag},
      {"temporary_prefix", integration->temporary_prefix},
      {"temporary_location", integration->temporary_location},
      {"quote", integration->quote},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(required_fields); index++) {
    if (!require_integration_field(integration, required_fields[index].name,
                                   required_fields[index].value, error)) {
      return false;
    }
  }
  if (integration->config_flags[0] == nullptr) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s strategy config requires field config_flags",
                integration->name);
    return false;
  }
  if (!g_str_has_suffix(integration->temporary_prefix, "XXXXXX")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s temporary_prefix must end in XXXXXX",
                integration->name);
    return false;
  }
  if (strlen(integration->quote) != 1 ||
      (*integration->quote != '\'' && *integration->quote != '"')) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s quote must be a single or double quote",
                integration->name);
    return false;
  }
  if (!g_str_equal(integration->temporary_location, "system") &&
      !g_str_equal(integration->temporary_location, "cache")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s temporary_location must be system or cache",
                integration->name);
    return false;
  }
  if (g_str_equal(integration->temporary_location, "cache") &&
      !require_integration_field(integration, "cache_subdirectory",
                                 integration->cache_subdirectory, error)) {
    return false;
  }
  if (ttr_string_is_set(integration->validation) &&
      !g_str_equal(integration->validation, "toml")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s has unsupported validation %s", integration->name,
                integration->validation);
    return false;
  }
  return true;
}

static const IntegrationStrategy integration_strategies[] = {
#define TTR_INTEGRATION_STRATEGY(enum_suffix, manifest_name, function_stem)            \
  {                                                                                    \
      .kind = TTR_INTEGRATION_STRATEGY_##enum_suffix,                                  \
      .name = (manifest_name),                                                         \
      .validate = function_stem##_integration_is_valid,                                \
  },
#include "integration-strategies.def"
#undef TTR_INTEGRATION_STRATEGY
};

static_assert(G_N_ELEMENTS(integration_strategies) + 1 ==
              TTR_INTEGRATION_STRATEGY_COUNT);

static bool integration_is_valid(TtrIntegration *integration, GError **error) {
  if (!ttr_string_is_set(integration->name) ||
      !ttr_string_is_set(integration->dark_theme) ||
      !ttr_string_is_set(integration->light_theme)) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "integration name and themes must not be empty");
    return false;
  }
  if (!ttr_string_is_set(integration->display_name)) {
    g_free(integration->display_name);
    integration->display_name = g_strdup(integration->name);
  }
  for (size_t index = 0; index < G_N_ELEMENTS(integration_strategies); index++) {
    const IntegrationStrategy *strategy = &integration_strategies[index];
    if (g_str_equal(integration->strategy, strategy->name)) {
      integration->strategy_kind = strategy->kind;
      return strategy->validate(integration, error);
    }
  }
  g_set_error(error, manifest_error_quark(), 1,
              "integration %s has unsupported strategy %s", integration->name,
              integration->strategy);
  return false;
}

static gpointer runner_from_table(toml_datum_t table, GError **error) {
  if (table.type != TOML_TABLE) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "runner entry must be a table");
    return nullptr;
  }
  TtrRunner *runner = g_new0(TtrRunner, 1);
  if (!ttr_toml_load_fields(table, runner, runner_fields, G_N_ELEMENTS(runner_fields),
                            error)) {
    g_free(runner);
    return nullptr;
  }
  if (!runner_is_valid(runner, error)) {
    runner_free(runner);
    return nullptr;
  }
  return runner;
}

static gpointer integration_from_table(toml_datum_t table, GError **error) {
  if (table.type != TOML_TABLE) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "integration entry must be a table");
    return nullptr;
  }
  TtrIntegration *integration = g_new0(TtrIntegration, 1);
  if (!ttr_toml_load_fields(table, integration, integration_fields,
                            G_N_ELEMENTS(integration_fields), error)) {
    g_free(integration);
    return nullptr;
  }
  if (!integration_is_valid(integration, error)) {
    integration_free(integration);
    return nullptr;
  }
  return integration;
}

static GHashTable *load_named_array(toml_datum_t root, const char *key,
                                    GDestroyNotify free_value, TableLoader loader,
                                    const char *source, GError **error) {
  const toml_datum_t array = toml_get(root, key);
  g_autoptr(GHashTable) records =
      g_hash_table_new_full(g_str_hash, g_str_equal, nullptr, free_value);
  if (array.type != TOML_UNKNOWN && array.type != TOML_ARRAY) {
    g_set_error(error, manifest_error_quark(), 1, "%s: %s must be an array of tables",
                source, key);
    return nullptr;
  }
  if (array.type == TOML_UNKNOWN) {
    return g_steal_pointer(&records);
  }
  for (int32_t index = 0; index < array.u.arr.size; index++) {
    NamedConfig *record = loader(array.u.arr.elem[index], error);
    if (record == nullptr) {
      g_prefix_error(error, "%s: ", source);
      return nullptr;
    }
    g_hash_table_replace(records, record->name, record);
  }
  return g_steal_pointer(&records);
}

static void manifest_fragment_clear(ManifestFragment *fragment) {
  if (fragment->runners != nullptr) {
    g_hash_table_unref(fragment->runners);
    fragment->runners = nullptr;
  }
  if (fragment->integrations != nullptr) {
    g_hash_table_unref(fragment->integrations);
    fragment->integrations = nullptr;
  }
}

G_DEFINE_AUTO_CLEANUP_CLEAR_FUNC(ManifestFragment, manifest_fragment_clear)

static bool parse_manifest_fragment(const char *contents, size_t length,
                                    const char *source, ManifestFragment *fragment,
                                    GError **error) {
  *fragment = (ManifestFragment){};
  if (length > INT_MAX) {
    g_set_error(error, manifest_error_quark(), 1, "%s is too large to parse", source);
    return false;
  }
  g_auto(toml_result_t) parsed = toml_parse_named(contents, (int)length, source);
  if (!parsed.ok) {
    g_set_error(error, manifest_error_quark(), 1, "failed to parse %s: %s", source,
                parsed.errmsg);
    return false;
  }
  fragment->runners = load_named_array(parsed.toptab, "runner", runner_free,
                                       runner_from_table, source, error);
  if (fragment->runners == nullptr) {
    return false;
  }
  fragment->integrations =
      load_named_array(parsed.toptab, "integration", integration_free,
                       integration_from_table, source, error);
  return fragment->integrations != nullptr;
}

static void merge_named_records(GHashTable *destination, GHashTable *overrides) {
  g_autoptr(GPtrArray) records = g_hash_table_steal_all_values(overrides);
  for (guint index = 0; index < records->len; index++) {
    NamedConfig *record = g_ptr_array_index(records, index);
    g_hash_table_replace(destination, record->name, record);
  }
  g_ptr_array_set_free_func(records, nullptr);
}

static bool runtime_commands_are_valid(char *const *commands, const char *field,
                                       GError **error) {
  for (size_t index = 0; commands[index] != nullptr; index++) {
    int count = 0;
    g_auto(GStrv) arguments = nullptr;
    g_autoptr(GError) parse_error = nullptr;
    if (!g_shell_parse_argv(commands[index], &count, &arguments, &parse_error) ||
        count == 0) {
      g_set_error(error, manifest_error_quark(), 1,
                  "runtime field %s contains an invalid command: %s", field,
                  parse_error != nullptr ? parse_error->message : "command is empty");
      return false;
    }
  }
  return true;
}

static bool theme_name_is_valid(const char *name) {
  return g_str_equal(name, "dark") || g_str_equal(name, "light");
}

static bool terminal_protocol_is_valid(const char *protocol) {
  return g_str_equal(protocol, "background") || g_str_equal(protocol, "color-scheme");
}

static bool runtime_is_valid(const TtrRuntimeConfig *runtime, GError **error) {
  const struct {
    const char *name;
    char *const *values;
    bool require_element;
  } string_vector_rules[] = {
      {"javascript_runtimes", runtime->javascript_runtimes, true},
      {"javascript_runtime_paths", runtime->javascript_runtime_paths, false},
      {"javascript_runtime_home_paths", runtime->javascript_runtime_home_paths, false},
      {"javascript_shebang_interpreters", runtime->javascript_shebang_interpreters,
       true},
      {"theme_environment", runtime->theme_environment, true},
      {"theme_dark_aliases", runtime->theme_dark_aliases, false},
      {"theme_light_aliases", runtime->theme_light_aliases, false},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(string_vector_rules); index++) {
    char *const *values = string_vector_rules[index].values;
    if ((string_vector_rules[index].require_element && values[0] == nullptr) ||
        ttr_strv_contains(values, "")) {
      g_set_error(error, manifest_error_quark(), 1,
                  "runtime field %s contains an empty required value",
                  string_vector_rules[index].name);
      return false;
    }
  }
  for (size_t index = 0; runtime->javascript_runtimes[index] != nullptr; index++) {
    if (g_path_is_absolute(runtime->javascript_runtimes[index]) ||
        strchr(runtime->javascript_runtimes[index], '/') != nullptr) {
      g_set_error(error, manifest_error_quark(), 1,
                  "javascript runtime %s must be a program name",
                  runtime->javascript_runtimes[index]);
      return false;
    }
  }
  for (size_t index = 0; runtime->javascript_shebang_interpreters[index] != nullptr;
       index++) {
    if (strchr(runtime->javascript_shebang_interpreters[index], '/') != nullptr) {
      g_set_error(error, manifest_error_quark(), 1,
                  "JavaScript shebang interpreter %s must be a program name",
                  runtime->javascript_shebang_interpreters[index]);
      return false;
    }
  }
  for (size_t index = 0; runtime->theme_environment[index] != nullptr; index++) {
    if (!environment_name_is_valid(runtime->theme_environment[index])) {
      g_set_error(error, manifest_error_quark(), 1,
                  "theme environment name %s is invalid",
                  runtime->theme_environment[index]);
      return false;
    }
  }
  if (!environment_name_is_valid(runtime->theme_terminal_program_environment)) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "theme terminal program environment name is invalid");
    return false;
  }
  const struct {
    const char *name;
    char *const *commands;
  } command_fields[] = {
      {"theme_macos_commands", runtime->theme_macos_commands},
      {"theme_unix_commands", runtime->theme_unix_commands},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(command_fields); index++) {
    if (!runtime_commands_are_valid(command_fields[index].commands,
                                    command_fields[index].name, error)) {
      return false;
    }
  }
  const struct {
    const char *name;
    const char *value;
  } fallback_fields[] = {
      {"theme_macos_fallback", runtime->theme_macos_fallback},
      {"theme_unix_fallback", runtime->theme_unix_fallback},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(fallback_fields); index++) {
    if (!theme_name_is_valid(fallback_fields[index].value)) {
      g_set_error(error, manifest_error_quark(), 1, "%s must be dark or light",
                  fallback_fields[index].name);
      return false;
    }
  }
  if (runtime->theme_probe_timeout_ms < 1 || runtime->theme_probe_timeout_ms > 60000) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "theme_probe_timeout_ms must be between 1 and 60000");
    return false;
  }
  const char *fallback = g_hash_table_lookup(runtime->theme_terminal_queries, "*");
  if (fallback == nullptr) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "theme_terminal_queries requires a * fallback");
    return false;
  }
  GHashTableIter iterator;
  gpointer protocol = nullptr;
  g_hash_table_iter_init(&iterator, runtime->theme_terminal_queries);
  while (g_hash_table_iter_next(&iterator, nullptr, &protocol)) {
    if (!terminal_protocol_is_valid(protocol)) {
      g_set_error(error, manifest_error_quark(), 1,
                  "theme_terminal_queries has unsupported protocol %s",
                  (const char *)protocol);
      return false;
    }
  }
  return true;
}

static bool load_runtime(TtrRuntimeConfig *runtime, GError **error) {
  *runtime = (TtrRuntimeConfig){};
  g_auto(toml_result_t) parsed = toml_parse_named(
      (const char *)default_runtime_data, (int)(sizeof default_runtime_data - 1),
      "embedded runtime-defaults.toml");
  if (!parsed.ok) {
    g_set_error(error, manifest_error_quark(), 1,
                "failed to parse embedded runtime-defaults.toml: %s", parsed.errmsg);
    return false;
  }
  if (!ttr_toml_load_fields(parsed.toptab, runtime, runtime_fields,
                            G_N_ELEMENTS(runtime_fields), error)) {
    g_prefix_error_literal(error, "embedded runtime-defaults.toml: ");
    return false;
  }
  if (!runtime_is_valid(runtime, error)) {
    ttr_toml_clear_fields(runtime, runtime_fields, G_N_ELEMENTS(runtime_fields));
    return false;
  }
  return true;
}

static bool runner_integrations_are_valid(const TtrManifest *manifest, GError **error) {
  GHashTableIter iterator;
  gpointer value = nullptr;
  g_hash_table_iter_init(&iterator, manifest->runners);
  while (g_hash_table_iter_next(&iterator, nullptr, &value)) {
    const TtrRunner *runner = value;
    if (ttr_string_is_set(runner->integration) &&
        !g_hash_table_contains(manifest->integrations, runner->integration)) {
      g_set_error(error, manifest_error_quark(), 1,
                  "runner %s references unknown integration %s", runner->name,
                  runner->integration);
      return false;
    }
  }
  return true;
}

TtrManifest *ttr_manifest_load(GError **error) {
  g_auto(ManifestFragment) defaults = {};
  if (!parse_manifest_fragment((const char *)default_runner_data,
                               sizeof default_runner_data - 1, "embedded runners.toml",
                               &defaults, error)) {
    return nullptr;
  }
  g_auto(ManifestFragment) integration_defaults = {};
  if (!parse_manifest_fragment(
          (const char *)default_integration_data, sizeof default_integration_data - 1,
          "embedded integrations.toml", &integration_defaults, error)) {
    return nullptr;
  }
  merge_named_records(defaults.runners, integration_defaults.runners);
  merge_named_records(defaults.integrations, integration_defaults.integrations);

  TtrManifest *manifest = g_new0(TtrManifest, 1);
  manifest->runners = g_steal_pointer(&defaults.runners);
  manifest->integrations = g_steal_pointer(&defaults.integrations);
  if (!load_runtime(&manifest->runtime, error)) {
    ttr_manifest_free(manifest);
    return nullptr;
  }

  g_auto(GStrv) paths = nullptr;
  const char *configured = g_getenv("TERMINAL_THEME_RUN_CONFIG");
  if (configured != nullptr && *configured != '\0') {
    paths = g_strsplit(configured, G_SEARCHPATH_SEPARATOR_S, -1);
  } else {
    paths = g_new0(char *, 2);
    paths[0] = g_build_filename(g_get_user_config_dir(), "terminal-theme-run",
                                "runners.toml", nullptr);
  }

  for (size_t index = 0; paths[index] != nullptr; index++) {
    g_autofree char *contents = nullptr;
    gsize length = 0;
    if (!g_file_get_contents(paths[index], &contents, &length, nullptr)) {
      continue;
    }
    g_auto(ManifestFragment) overrides = {};
    if (!parse_manifest_fragment(contents, length, paths[index], &overrides, error)) {
      ttr_manifest_free(manifest);
      return nullptr;
    }
    merge_named_records(manifest->runners, overrides.runners);
    merge_named_records(manifest->integrations, overrides.integrations);
  }

  if (!runner_integrations_are_valid(manifest, error)) {
    ttr_manifest_free(manifest);
    return nullptr;
  }
  return manifest;
}

void ttr_manifest_free(TtrManifest *manifest) {
  if (manifest == nullptr) {
    return;
  }
  if (manifest->runners != nullptr) {
    g_hash_table_unref(manifest->runners);
  }
  if (manifest->integrations != nullptr) {
    g_hash_table_unref(manifest->integrations);
  }
  ttr_toml_clear_fields(&manifest->runtime, runtime_fields,
                        G_N_ELEMENTS(runtime_fields));
  g_free(manifest);
}

const TtrRunner *ttr_manifest_find(const TtrManifest *manifest, const char *name) {
  if (manifest == nullptr || name == nullptr) {
    return nullptr;
  }
  return g_hash_table_lookup(manifest->runners, name);
}

const TtrIntegration *ttr_manifest_find_integration(const TtrManifest *manifest,
                                                    const char *name) {
  if (manifest == nullptr || name == nullptr || *name == '\0') {
    return nullptr;
  }
  return g_hash_table_lookup(manifest->integrations, name);
}

const TtrRuntimeConfig *ttr_manifest_runtime(const TtrManifest *manifest) {
  return manifest != nullptr ? &manifest->runtime : nullptr;
}

static int compare_strings(const void *left, const void *right) {
  return g_strcmp0(left, right);
}

char **ttr_manifest_program_names(const TtrManifest *manifest) {
  if (manifest == nullptr) {
    return g_new0(char *, 1);
  }
  guint count = 0;
  gpointer *keys = g_hash_table_get_keys_as_array(manifest->runners, &count);
  g_autoptr(GPtrArray) names = g_ptr_array_new_null_terminated(count, g_free, true);
  for (guint index = 0; index < count; index++) {
    g_ptr_array_add(names, g_strdup(keys[index]));
  }
  g_free(keys);
  g_ptr_array_sort_values(names, compare_strings);
  return (char **)g_ptr_array_steal(names, nullptr);
}
