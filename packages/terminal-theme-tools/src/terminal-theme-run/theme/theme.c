#include "theme/theme.h"

#include "config/toml-schema.h"
#include "support/filesystem.h"
#include "support/strings.h"
#include "theme/context.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gunixoutputstream.h>
#include <glib/gstdio.h>
#include <limits.h>
#include <string.h>
#include <unistd.h>

static constexpr int temporary_directory_mode = 0700;

static GQuark theme_error_quark(void) {
  return g_quark_from_static_string("terminal-theme-run-theme-error");
}

static const char *theme_name(const TtrIntegration *integration, TtrThemeMode mode) {
  const char *const themes[TTR_THEME_MODE_COUNT] = {
      [TTR_THEME_DARK] = integration->dark_theme,
      [TTR_THEME_LIGHT] = integration->light_theme,
  };
  g_return_val_if_fail(mode < TTR_THEME_MODE_COUNT, integration->dark_theme);
  return themes[mode];
}

void ttr_prepared_args_clear(TtrPreparedArgs *prepared) {
  if (prepared == nullptr) {
    return;
  }
  g_strfreev(prepared->argv);
  if (prepared->temporary_path != nullptr) {
    (void)g_unlink(prepared->temporary_path);
  }
  g_free(prepared->temporary_path);
  *prepared = (TtrPreparedArgs){};
}

static char *render_argument(const char *template, const char *theme,
                             const char *context) {
  g_autofree char *with_theme =
      ttr_string_replace(template, ttr_theme_placeholder, theme);
  return ttr_string_replace(with_theme, ttr_context_placeholder, context);
}

static bool joined_config_flag_matches(const TtrIntegration *config,
                                       const char *argument) {
  for (size_t index = 0; config->config_flags[index] != nullptr; index++) {
    const size_t length = strlen(config->config_flags[index]);
    if (strncmp(argument, config->config_flags[index], length) == 0 &&
        argument[length] == '=') {
      return true;
    }
  }
  return false;
}

static char *config_path(const TtrIntegration *config, char *const *arguments) {
  if (arguments != nullptr) {
    for (size_t index = 0; arguments[index] != nullptr; index++) {
      const char *argument = arguments[index];
      if (ttr_strv_contains(config->config_flags, argument) &&
          arguments[index + 1] != nullptr) {
        return ttr_expand_path(arguments[index + 1]);
      }
      if (joined_config_flag_matches(config, argument)) {
        const char *separator = strchr(argument, '=');
        return ttr_expand_path(separator + 1);
      }
    }
  }
  const char *home = ttr_home_directory();
  return home == nullptr ? g_strdup("")
                         : g_build_filename(home, config->default_config, nullptr);
}

static void append_without_config_args(const TtrIntegration *config,
                                       GStrvBuilder *output, char *const *arguments) {
  if (arguments == nullptr) {
    return;
  }
  for (size_t index = 0; arguments[index] != nullptr; index++) {
    if (ttr_strv_contains(config->config_flags, arguments[index])) {
      if (arguments[index + 1] != nullptr) {
        index++;
      }
      continue;
    }
    if (joined_config_flag_matches(config, arguments[index])) {
      continue;
    }
    g_strv_builder_add(output, arguments[index]);
  }
}

static bool assignment_key_matches(const char *line, const char *key) {
  while (g_ascii_isspace(*line)) {
    line++;
  }
  const size_t key_length = strlen(key);
  if (strncmp(line, key, key_length) != 0) {
    return false;
  }
  line += key_length;
  while (*line == ' ' || *line == '\t') {
    line++;
  }
  return *line == '=';
}

static bool table_header_belongs_to_key(const char *line, const char *key) {
  while (g_ascii_isspace(*line)) {
    line++;
  }
  if (*line != '[' || line[1] == '[') {
    return false;
  }
  line++;
  while (g_ascii_isspace(*line)) {
    line++;
  }
  const size_t key_length = strlen(key);
  if (strncmp(line, key, key_length) != 0) {
    return false;
  }
  line += key_length;
  while (*line == ' ' || *line == '\t') {
    line++;
  }
  return *line == ']' || *line == '.';
}

static char *patch_assignment(const char *text, const char *key,
                              const char *quoted_value, int parsed_line,
                              toml_type_t assignment_type) {
  g_auto(GStrv) lines = g_strsplit(text != nullptr ? text : "", "\n", -1);
  g_autoptr(GString) output = g_string_new(nullptr);
  bool replaced = false;
  bool skipping_table = false;
  for (size_t index = 0; lines[index] != nullptr; index++) {
    const char *line = lines[index];
    if (skipping_table) {
      const char *trimmed = line;
      while (g_ascii_isspace(*trimmed)) {
        trimmed++;
      }
      if (*trimmed != '[') {
        continue;
      }
      if (table_header_belongs_to_key(line, key)) {
        continue;
      }
      skipping_table = false;
    }
    const bool matches = parsed_line > 0 ? index + 1 == (size_t)parsed_line
                                         : assignment_key_matches(line, key);
    if (!replaced && matches) {
      g_string_append_printf(output, "%s = %s", key, quoted_value);
      replaced = true;
      skipping_table =
          assignment_type == TOML_TABLE && table_header_belongs_to_key(line, key);
    } else {
      g_string_append(output, line);
    }
    if (lines[index + 1] != nullptr) {
      g_string_append_c(output, '\n');
    }
  }
  if (!replaced) {
    if (parsed_line >= 0) {
      g_autofree char *assignment = g_strdup_printf("%s = %s\n", key, quoted_value);
      g_string_prepend(output, assignment);
    } else {
      if (output->len > 0 && output->str[output->len - 1] != '\n') {
        g_string_append_c(output, '\n');
      }
      g_string_append_printf(output, "%s = %s\n", key, quoted_value);
    }
  }
  return g_string_free_and_steal(g_steal_pointer(&output));
}

static bool write_temporary(const char *directory, const char *prefix,
                            const char *contents, gsize length, char **path,
                            GError **error) {
  if (g_mkdir_with_parents(directory, temporary_directory_mode) != 0) {
    const int saved_errno = errno;
    const GFileError file_error = g_file_error_from_errno(saved_errno);
    g_set_error(error, G_FILE_ERROR, (gint)file_error, "failed to create %s: %s",
                directory, g_strerror(saved_errno));
    return false;
  }
  char *template = g_build_filename(directory, prefix, nullptr);
  const int descriptor =
      g_mkstemp_full(template, O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR);
  if (descriptor < 0) {
    const int saved_errno = errno;
    const GFileError file_error = g_file_error_from_errno(saved_errno);
    g_set_error(error, G_FILE_ERROR, (gint)file_error,
                "failed to create temporary file %s: %s", template,
                g_strerror(saved_errno));
    g_free(template);
    return false;
  }
  g_autoptr(GOutputStream) stream = g_unix_output_stream_new(descriptor, true);
  bool wrote =
      g_output_stream_write_all(stream, contents, length, nullptr, nullptr, error);
  if (wrote) {
    wrote = g_output_stream_close(stream, nullptr, error);
  } else {
    (void)g_output_stream_close(stream, nullptr, nullptr);
  }
  if (wrote) {
    *path = template;
    return true;
  }
  (void)g_unlink(template);
  g_free(template);
  return false;
}

static bool inspect_config(const TtrIntegration *config, const char *contents,
                           gsize length, int *assignment_line,
                           toml_type_t *assignment_type, GError **error) {
  const bool validate_toml = config->validation_kind == TTR_CONFIG_VALIDATION_TOML;
  *assignment_line = validate_toml ? 0 : -1;
  *assignment_type = TOML_UNKNOWN;
  if (!validate_toml || length == 0) {
    return true;
  }
  if (length > INT_MAX) {
    g_set_error(error, theme_error_quark(), 1, "%s config is too large to parse",
                config->display_name);
    return false;
  }
  g_auto(toml_result_t) parsed = toml_parse(contents, (int)length);
  if (!parsed.ok) {
    g_set_error(error, theme_error_quark(), 1, "failed to parse %s config: %s",
                config->display_name, parsed.errmsg);
    return false;
  }
  const toml_datum_t assignment = toml_get(parsed.toptab, config->assignment);
  if (assignment.type != TOML_UNKNOWN && assignment.type != TOML_STRING &&
      assignment.type != TOML_TABLE) {
    g_set_error(error, theme_error_quark(), 1, "%s config field %s must be a string",
                config->display_name, config->assignment);
    return false;
  }
  *assignment_type = assignment.type;
  if (assignment.type == TOML_STRING || assignment.type == TOML_TABLE) {
    *assignment_line = assignment.lineno;
  }
  return true;
}

static char *temporary_directory(const TtrIntegration *config) {
  if (config->temporary_location_kind == TTR_TEMPORARY_LOCATION_SYSTEM) {
    return ttr_user_temporary_directory();
  }
  g_assert(config->temporary_location_kind == TTR_TEMPORARY_LOCATION_CACHE);
  g_autofree char *cache = ttr_user_cache_directory();
  return g_build_filename(cache, config->cache_subdirectory, nullptr);
}

static bool prepare_argument_theme_args(const TtrIntegration *config,
                                        const TtrRuntimeConfig *runtime,
                                        TtrThemeMode mode, char *const *extra_args,
                                        TtrPreparedArgs *prepared,
                                        [[maybe_unused]] GError **error) {
  const char *theme = theme_name(config, mode);
  g_autofree char *context = nullptr;
  if (ttr_string_is_set(config->context_table)) {
    const TtrDirectoryContextPolicy policy = {
        .toml =
            {
                .table = config->context_table,
                .field = config->context_field,
                .value = config->context_value,
            },
        .arguments =
            {
                .flags = config->context_path_flags,
                .prefixes = config->context_path_prefixes,
                .separator = config->context_argument_separator,
            },
        .discovery =
            {
                .commands = config->context_directory_commands,
                .timeout_ms = (guint)runtime->helper_timeout_ms,
                .output_limit_bytes = (gsize)runtime->helper_output_limit_bytes,
            },
    };
    context = ttr_toml_directory_context(&policy, extra_args);
  }
  g_autoptr(GStrvBuilder) arguments = g_strv_builder_new();
  for (size_t index = 0; config->arguments[index] != nullptr; index++) {
    g_autofree char *rendered =
        render_argument(config->arguments[index], theme, context);
    g_strv_builder_add(arguments, rendered);
  }
  ttr_strv_builder_addv(arguments, extra_args);
  prepared->argv = g_strv_builder_end(arguments);
  return true;
}

static bool prepare_config_theme_args(const TtrIntegration *config,
                                      [[maybe_unused]] const TtrRuntimeConfig *runtime,
                                      TtrThemeMode mode, char *const *extra_args,
                                      TtrPreparedArgs *prepared, GError **error) {
  g_autofree char *path = config_path(config, extra_args);
  g_autofree char *contents = nullptr;
  gsize length = 0;
  const TtrFileReadResult read =
      ttr_read_regular_file(path, ttr_max_input_file_bytes, &contents, &length, error);
  if (read == TTR_FILE_READ_NOT_FOUND) {
    contents = g_strdup("");
    length = 0;
  } else if (read == TTR_FILE_READ_ERROR) {
    g_prefix_error(error, "failed to load %s config: ", config->display_name);
    return false;
  }
  int assignment_line = -1;
  toml_type_t assignment_type = TOML_UNKNOWN;
  if (!inspect_config(config, contents, length, &assignment_line, &assignment_type,
                      error)) {
    return false;
  }

  const char *theme = theme_name(config, mode);
  g_autofree char *quoted = g_strdup_printf("%c%s%c", config->quote_character, theme,
                                            config->quote_character);
  g_autofree char *patched = patch_assignment(contents, config->assignment, quoted,
                                              assignment_line, assignment_type);
  int generated_assignment_line = -1;
  toml_type_t generated_assignment_type = TOML_UNKNOWN;
  if (!inspect_config(config, patched, strlen(patched), &generated_assignment_line,
                      &generated_assignment_type, error)) {
    return false;
  }

  g_autofree char *directory = temporary_directory(config);
  if (!write_temporary(directory, config->temporary_prefix, patched, strlen(patched),
                       &prepared->temporary_path, error)) {
    return false;
  }

  g_autoptr(GStrvBuilder) arguments = g_strv_builder_new();
  g_strv_builder_add(arguments, config->config_output_flag);
  g_strv_builder_add(arguments, prepared->temporary_path);
  append_without_config_args(config, arguments, extra_args);
  prepared->argv = g_strv_builder_end(arguments);
  return true;
}

bool ttr_prepare_integration(const TtrIntegration *integration,
                             const TtrRuntimeConfig *runtime, char *const *extra_args,
                             TtrPreparedArgs *prepared, GError **error) {
  g_return_val_if_fail(prepared != nullptr, false);
  g_return_val_if_fail(runtime != nullptr, false);
  *prepared = (TtrPreparedArgs){};
  if (integration == nullptr) {
    prepared->argv = ttr_strv_concat(extra_args, nullptr);
    return true;
  }
  if (integration->strategy_kind <= TTR_INTEGRATION_STRATEGY_INVALID ||
      integration->strategy_kind >= TTR_INTEGRATION_STRATEGY_COUNT) {
    g_set_error(error, theme_error_quark(), 1,
                "integration %s has no validated strategy", integration->name);
    return false;
  }

  const TtrThemeMode mode = ttr_detect_theme(runtime);
  switch (integration->strategy_kind) {
#define TTR_INTEGRATION_STRATEGY(enum_suffix, manifest_name, function_stem)            \
  case TTR_INTEGRATION_STRATEGY_##enum_suffix:                                         \
    return prepare_##function_stem##_theme_args(integration, runtime, mode,            \
                                                extra_args, prepared, error);
#include "config/definitions/integration-strategies.def"
#undef TTR_INTEGRATION_STRATEGY
  case TTR_INTEGRATION_STRATEGY_INVALID:
  case TTR_INTEGRATION_STRATEGY_COUNT:
  default:
    g_assert_not_reached();
  }
}
