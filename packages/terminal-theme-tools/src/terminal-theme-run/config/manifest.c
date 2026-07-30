#include "config/manifest.h"
#include "config.h"

#include "config/toml-schema.h"
#include "support/filesystem.h"
#include "support/strings.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define TTR_FIELD_C_TYPE_STRING char *
#define TTR_FIELD_C_TYPE_STRING_ARRAY char **
#define TTR_FIELD_C_TYPE_STRING_MAP GHashTable *
#define TTR_FIELD_C_TYPE_ENVIRONMENT GHashTable *
#define TTR_FIELD_C_TYPE_INT64 gint64

/*
 * C23's typeof_unqual and empty initialization let the schema prove that each
 * offset names the exact C type its loader accesses. A field-list edit that
 * pairs (for example) a char ** member with the string loader now fails during
 * translation instead of depending on object-pointer representation details.
 */
#define TTR_ASSERT_SCHEMA_FIELD(record_type, member, field_type, is_required)          \
  static_assert(_Generic((typeof_unqual(((record_type *)nullptr)->member)){},          \
                    TTR_FIELD_C_TYPE_##field_type: true,                               \
                    default: false),                                                   \
                #record_type "." #member " has the wrong C type for " #field_type)

#define TTR_RUNNER_FIELD(member, field_type, is_required)                              \
  TTR_ASSERT_SCHEMA_FIELD(TtrRunner, member, field_type, is_required);
#include "definitions/runner-fields.def"
#undef TTR_RUNNER_FIELD

#define TTR_INTEGRATION_FIELD(member, field_type, is_required)                         \
  TTR_ASSERT_SCHEMA_FIELD(TtrIntegration, member, field_type, is_required);
#include "definitions/integration-fields.def"
#undef TTR_INTEGRATION_FIELD

#define TTR_RUNTIME_FIELD(member, field_type, is_required)                             \
  TTR_ASSERT_SCHEMA_FIELD(TtrRuntimeConfig, member, field_type, is_required);
#include "definitions/runtime-fields.def"
#undef TTR_RUNTIME_FIELD

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
#include "definitions/runner-fields.def"
#undef TTR_RUNNER_FIELD
};

static const TtrTomlField integration_fields[] = {
#define TTR_INTEGRATION_FIELD(member, field_type, is_required)                         \
  TTR_SCHEMA_FIELD(TtrIntegration, member, field_type, is_required)
#include "definitions/integration-fields.def"
#undef TTR_INTEGRATION_FIELD
};

static const TtrTomlField runtime_fields[] = {
#define TTR_RUNTIME_FIELD(member, field_type, is_required)                             \
  TTR_SCHEMA_FIELD(TtrRuntimeConfig, member, field_type, is_required)
#include "definitions/runtime-fields.def"
#undef TTR_RUNTIME_FIELD
};

#undef TTR_SCHEMA_FIELD
#undef TTR_ASSERT_SCHEMA_FIELD
#undef TTR_FIELD_C_TYPE_INT64
#undef TTR_FIELD_C_TYPE_ENVIRONMENT
#undef TTR_FIELD_C_TYPE_STRING_MAP
#undef TTR_FIELD_C_TYPE_STRING_ARRAY
#undef TTR_FIELD_C_TYPE_STRING

typedef gpointer (*TableLoader)(toml_datum_t table, GError **error);
typedef char *(*RecordName)(gpointer record);

typedef struct {
  GHashTable *runners;
  GHashTable *integrations;
} ManifestFragment;

typedef bool (*IntegrationValidator)(TtrIntegration *integration, GError **error);

typedef struct {
  TtrIntegrationStrategy kind;
  const char *name;
  IntegrationValidator validate;
} IntegrationStrategy;

typedef struct {
  const char *name;
  const char *value;
} RequiredStringField;

typedef struct {
  const char *name;
  char *const *values;
  bool require_element;
} StringVectorRule;

typedef struct {
  const char *name;
  char *const *commands;
} CommandField;

typedef struct {
  const char *name;
  const char *value;
  TtrThemeMode *mode;
} ThemeFallbackField;

typedef struct {
  const char *name;
  gint64 value;
  gint64 minimum;
  gint64 maximum;
} IntegerRule;

typedef struct {
  const char *key;
  GHashTable **destination;
  GDestroyNotify destroy;
  TableLoader load;
  RecordName name;
} ManifestTableRule;

static constexpr char data_directory_environment[] = "TERMINAL_THEME_RUN_DATA_DIR";
static constexpr char user_config_environment[] = "TERMINAL_THEME_RUN_CONFIG";
static constexpr char user_config_directory[] = "terminal-theme-run";
static constexpr char user_config_file[] = "runners.toml";
static constexpr char runtime_defaults_file[] = "runtime-defaults.toml";
static constexpr gint64 minimum_runtime_limit = 1;
static constexpr gint64 maximum_runtime_timeout_ms = 60LL * 1000LL;
static constexpr gint64 maximum_helper_output_bytes = 1024LL * 1024LL;

static const char *const manifest_default_files[] = {
    "runners.toml",
    "integrations.toml",
};

static GQuark manifest_error_quark(void) {
  return g_quark_from_static_string("terminal-theme-run-manifest-error");
}

static const char *data_directory(void) {
  const char *configured = g_getenv(data_directory_environment);
  return ttr_string_is_set(configured) ? configured : TTR_DATA_DIR;
}

static bool load_default_data(const char *name, char **contents, gsize *length,
                              char **source, GError **error) {
  *source = g_build_filename(data_directory(), name, nullptr);
  const TtrFileReadResult read =
      ttr_read_regular_file(*source, ttr_max_input_file_bytes, contents, length, error);
  if (read == TTR_FILE_READ_OK) {
    return true;
  }
  if (read == TTR_FILE_READ_NOT_FOUND) {
    g_set_error(error, G_FILE_ERROR, G_FILE_ERROR_NOENT, "%s does not exist", *source);
  }
  g_prefix_error(error, "failed to load terminal-theme-run runtime data %s: ", *source);
  return false;
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

static bool argument_integration_is_valid(TtrIntegration *integration, GError **error) {
  if (integration->arguments[0] == nullptr) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s strategy arguments requires field arguments",
                integration->name);
    return false;
  }
  if (!templates_contain(integration->arguments, ttr_theme_placeholder)) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s arguments do not contain {theme}", integration->name);
    return false;
  }

  const bool has_table = ttr_string_is_set(integration->context_table);
  const bool has_field = ttr_string_is_set(integration->context_field);
  const bool has_value = ttr_string_is_set(integration->context_value);
  const bool has_context_options =
      integration->context_path_flags[0] != nullptr ||
      integration->context_path_prefixes[0] != nullptr ||
      ttr_string_is_set(integration->context_argument_separator) ||
      integration->context_directory_commands[0] != nullptr;
  if (has_table != has_field || has_field != has_value) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s must set context_table, context_field, and "
                "context_value "
                "together",
                integration->name);
    return false;
  }
  if (!has_table && has_context_options) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s context options require context_table, "
                "context_field, and context_value",
                integration->name);
    return false;
  }
  if (has_table &&
      !templates_contain(integration->arguments, ttr_context_placeholder)) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s arguments do not contain {context}", integration->name);
    return false;
  }
  if (ttr_strv_contains(integration->context_path_flags, "") ||
      ttr_strv_contains(integration->context_path_prefixes, "")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s context path flags must not be empty",
                integration->name);
    return false;
  }
  for (size_t index = 0; integration->context_directory_commands[index] != nullptr;
       index++) {
    int count = 0;
    g_auto(GStrv) arguments = nullptr;
    g_autoptr(GError) parse_error = nullptr;
    const char *command = integration->context_directory_commands[index];
    if (!g_shell_parse_argv(command, &count, &arguments, &parse_error) || count == 0) {
      g_set_error(error, manifest_error_quark(), 1,
                  "integration %s has an invalid context directory command: %s",
                  integration->name,
                  parse_error != nullptr ? parse_error->message : "command is empty");
      return false;
    }
    if (strstr(command, ttr_directory_placeholder) == nullptr) {
      g_set_error(error, manifest_error_quark(), 1,
                  "integration %s context directory commands must contain "
                  "{directory}",
                  integration->name);
      return false;
    }
  }
  return true;
}

static bool config_integration_is_valid(TtrIntegration *integration, GError **error) {
  const RequiredStringField required_fields[] = {
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
  if (ttr_strv_contains(integration->config_flags, "")) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s config_flags must not contain an empty flag",
                integration->name);
    return false;
  }
  if (!g_str_has_suffix(integration->temporary_prefix, ttr_temporary_template_suffix)) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s temporary_prefix must end in XXXXXX",
                integration->name);
    return false;
  }
  if (strchr(integration->temporary_prefix, G_DIR_SEPARATOR) != nullptr) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s temporary_prefix must be a file name",
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
  integration->quote_character = *integration->quote;
  if (!ttr_temporary_location_from_name(integration->temporary_location,
                                        &integration->temporary_location_kind)) {
    g_set_error(error, manifest_error_quark(), 1,
                "integration %s temporary_location must be system or cache",
                integration->name);
    return false;
  }
  if (integration->temporary_location_kind == TTR_TEMPORARY_LOCATION_CACHE &&
      !require_integration_field(integration, "cache_subdirectory",
                                 integration->cache_subdirectory, error)) {
    return false;
  }
  if (!ttr_config_validation_from_name(integration->validation,
                                       &integration->validation_kind)) {
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
#include "definitions/integration-strategies.def"
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

static char *runner_name(gpointer record) { return ((TtrRunner *)record)->name; }

static char *integration_name(gpointer record) {
  return ((TtrIntegration *)record)->name;
}

static GHashTable *load_named_array(toml_datum_t root, const char *key,
                                    GDestroyNotify free_value, TableLoader loader,
                                    RecordName record_name, const char *source,
                                    GError **error) {
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
    gpointer record = loader(array.u.arr.elem[index], error);
    if (record == nullptr) {
      g_prefix_error(error, "%s: ", source);
      return nullptr;
    }
    g_hash_table_replace(records, record_name(record), record);
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
  const ManifestTableRule tables[] = {
      {
          .key = "runner",
          .destination = &fragment->runners,
          .destroy = runner_free,
          .load = runner_from_table,
          .name = runner_name,
      },
      {
          .key = "integration",
          .destination = &fragment->integrations,
          .destroy = integration_free,
          .load = integration_from_table,
          .name = integration_name,
      },
  };
  for (size_t index = 0; index < G_N_ELEMENTS(tables); index++) {
    *tables[index].destination =
        load_named_array(parsed.toptab, tables[index].key, tables[index].destroy,
                         tables[index].load, tables[index].name, source, error);
    if (*tables[index].destination == nullptr) {
      return false;
    }
  }
  return true;
}

static void merge_named_records(GHashTable *destination, GHashTable *overrides) {
  GHashTableIter iterator;
  gpointer key = nullptr;
  gpointer record = nullptr;
  g_hash_table_iter_init(&iterator, overrides);
  while (g_hash_table_iter_next(&iterator, &key, &record)) {
    g_hash_table_iter_steal(&iterator);
    g_hash_table_replace(destination, key, record);
  }
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

static bool runtime_is_valid(TtrRuntimeConfig *runtime, GError **error) {
  const StringVectorRule string_vector_rules[] = {
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
  const CommandField command_fields[] = {
      {"theme_macos_commands", runtime->theme_macos_commands},
      {"theme_unix_commands", runtime->theme_unix_commands},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(command_fields); index++) {
    if (!runtime_commands_are_valid(command_fields[index].commands,
                                    command_fields[index].name, error)) {
      return false;
    }
  }
  const ThemeFallbackField fallback_fields[] = {
      {"theme_macos_fallback", runtime->theme_macos_fallback,
       &runtime->theme_macos_fallback_mode},
      {"theme_unix_fallback", runtime->theme_unix_fallback,
       &runtime->theme_unix_fallback_mode},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(fallback_fields); index++) {
    if (!ttr_theme_mode_from_name(fallback_fields[index].value,
                                  fallback_fields[index].mode)) {
      g_set_error(error, manifest_error_quark(), 1, "%s must be dark or light",
                  fallback_fields[index].name);
      return false;
    }
  }
  const IntegerRule integer_rules[] = {
      {"theme_probe_timeout_ms", runtime->theme_probe_timeout_ms, minimum_runtime_limit,
       maximum_runtime_timeout_ms},
      {"helper_timeout_ms", runtime->helper_timeout_ms, minimum_runtime_limit,
       maximum_runtime_timeout_ms},
      {"helper_output_limit_bytes", runtime->helper_output_limit_bytes,
       minimum_runtime_limit, maximum_helper_output_bytes},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(integer_rules); index++) {
    const IntegerRule *rule = &integer_rules[index];
    if (rule->value < rule->minimum || rule->value > rule->maximum) {
      g_set_error(error, manifest_error_quark(), 1,
                  "%s must be between %" G_GINT64_FORMAT " and %" G_GINT64_FORMAT,
                  rule->name, rule->minimum, rule->maximum);
      return false;
    }
  }
  const char *fallback = g_hash_table_lookup(runtime->theme_terminal_queries,
                                             ttr_terminal_protocol_fallback_key);
  if (fallback == nullptr) {
    g_set_error_literal(error, manifest_error_quark(), 1,
                        "theme_terminal_queries requires a * fallback");
    return false;
  }
  GHashTableIter iterator;
  gpointer protocol = nullptr;
  g_hash_table_iter_init(&iterator, runtime->theme_terminal_queries);
  while (g_hash_table_iter_next(&iterator, nullptr, &protocol)) {
    TtrTerminalProtocol parsed_protocol = TTR_TERMINAL_PROTOCOL_INVALID;
    if (!ttr_terminal_protocol_from_name(protocol, &parsed_protocol)) {
      g_set_error(error, manifest_error_quark(), 1,
                  "theme_terminal_queries has unsupported protocol %s",
                  (const char *)protocol);
      return false;
    }
  }
  return true;
}

static bool load_runtime(const char *contents, size_t length, const char *source,
                         TtrRuntimeConfig *runtime, GError **error) {
  *runtime = (TtrRuntimeConfig){};
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
  if (!ttr_toml_load_fields(parsed.toptab, runtime, runtime_fields,
                            G_N_ELEMENTS(runtime_fields), error)) {
    g_prefix_error(error, "%s: ", source);
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

static bool load_default_fragments(ManifestFragment *defaults, GError **error) {
  *defaults = (ManifestFragment){};
  for (size_t index = 0; index < G_N_ELEMENTS(manifest_default_files); index++) {
    g_autofree char *contents = nullptr;
    g_autofree char *source = nullptr;
    gsize length = 0;
    if (!load_default_data(manifest_default_files[index], &contents, &length, &source,
                           error)) {
      return false;
    }
    g_auto(ManifestFragment) fragment = {};
    if (!parse_manifest_fragment(contents, length, source, &fragment, error)) {
      return false;
    }
    if (defaults->runners == nullptr) {
      defaults->runners = g_steal_pointer(&fragment.runners);
      defaults->integrations = g_steal_pointer(&fragment.integrations);
      continue;
    }
    merge_named_records(defaults->runners, fragment.runners);
    merge_named_records(defaults->integrations, fragment.integrations);
  }
  return true;
}

TtrManifest *ttr_manifest_load(GError **error) {
  g_auto(ManifestFragment) defaults = {};
  if (!load_default_fragments(&defaults, error)) {
    return nullptr;
  }

  TtrManifest *manifest = g_new0(TtrManifest, 1);
  manifest->runners = g_steal_pointer(&defaults.runners);
  manifest->integrations = g_steal_pointer(&defaults.integrations);

  g_autofree char *runtime_data = nullptr;
  g_autofree char *runtime_source = nullptr;
  gsize runtime_length = 0;
  if (!load_default_data(runtime_defaults_file, &runtime_data, &runtime_length,
                         &runtime_source, error) ||
      !load_runtime(runtime_data, runtime_length, runtime_source, &manifest->runtime,
                    error)) {
    ttr_manifest_free(manifest);
    return nullptr;
  }

  g_auto(GStrv) paths = nullptr;
  const char *configured = g_getenv(user_config_environment);
  if (ttr_string_is_set(configured)) {
    paths = g_strsplit(configured, G_SEARCHPATH_SEPARATOR_S, -1);
  } else {
    paths = g_new0(char *, 2);
    paths[0] = g_build_filename(g_get_user_config_dir(), user_config_directory,
                                user_config_file, nullptr);
  }

  for (size_t index = 0; paths[index] != nullptr; index++) {
    g_autofree char *contents = nullptr;
    gsize length = 0;
    const TtrFileReadResult read = ttr_read_regular_file(
        paths[index], ttr_max_input_file_bytes, &contents, &length, error);
    if (read == TTR_FILE_READ_NOT_FOUND) {
      continue;
    }
    if (read == TTR_FILE_READ_ERROR) {
      g_prefix_error(error,
                     "failed to load terminal-theme-run config %s: ", paths[index]);
      ttr_manifest_free(manifest);
      return nullptr;
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
