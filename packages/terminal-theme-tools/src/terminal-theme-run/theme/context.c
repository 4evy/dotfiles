#include "theme/context.h"

#include "config/values.h"
#include "support/strings.h"
#include "support/subprocess.h"

#include <gio/gio.h>
#include <string.h>

static const char *joined_value(char *const *prefixes, const char *argument) {
  for (size_t index = 0; prefixes[index] != nullptr; index++) {
    const size_t length = strlen(prefixes[index]);
    if (g_str_has_prefix(argument, prefixes[index]) && argument[length] != '\0') {
      return argument + length;
    }
  }
  return nullptr;
}

static const char *path_override(char *const *arguments, char *const *path_flags,
                                 char *const *path_prefixes,
                                 const char *argument_separator) {
  const char *override = nullptr;
  if (arguments == nullptr) {
    return nullptr;
  }
  for (size_t index = 0; arguments[index] != nullptr; index++) {
    const char *argument = arguments[index];
    if (ttr_string_is_set(argument_separator) &&
        g_str_equal(argument, argument_separator)) {
      break;
    }
    if (ttr_strv_contains(path_flags, argument)) {
      if (arguments[index + 1] != nullptr) {
        override = arguments[++index];
      }
      continue;
    }
    const char *joined = joined_value(path_prefixes, argument);
    if (joined != nullptr) {
      override = joined;
    }
  }
  return override;
}

static char *effective_directory(char *const *arguments, char *const *path_flags,
                                 char *const *path_prefixes,
                                 const char *argument_separator) {
  char *current = g_get_current_dir();
  const char *override =
      path_override(arguments, path_flags, path_prefixes, argument_separator);
  if (override == nullptr) {
    return current;
  }
  char *resolved = g_canonicalize_filename(override, current);
  g_free(current);
  return resolved;
}

static char *directory_from_command(const char *command, const char *directory,
                                    guint helper_timeout_ms,
                                    gsize helper_output_limit_bytes) {
  int argument_count = 0;
  g_auto(GStrv) arguments = nullptr;
  if (!g_shell_parse_argv(command, &argument_count, &arguments, nullptr) ||
      argument_count == 0) {
    return nullptr;
  }
  for (int index = 0; index < argument_count; index++) {
    char *expanded =
        ttr_string_replace(arguments[index], ttr_directory_placeholder, directory);
    g_free(arguments[index]);
    arguments[index] = expanded;
  }

  g_autofree char *output = nullptr;
  bool successful = false;
  if (!ttr_subprocess_capture_stdout((const char *const *)arguments, helper_timeout_ms,
                                     helper_output_limit_bytes, &output, &successful,
                                     nullptr) ||
      !successful || output == nullptr) {
    return nullptr;
  }
  g_strstrip(output);
  if (*output == '\0' || strchr(output, '\n') != nullptr) {
    return nullptr;
  }
  char *resolved = g_canonicalize_filename(output, directory);
  if (!g_file_test(resolved, G_FILE_TEST_IS_DIR)) {
    g_free(resolved);
    return nullptr;
  }
  return resolved;
}

static char **context_directories(char *const *arguments, char *const *path_flags,
                                  char *const *path_prefixes,
                                  const char *argument_separator,
                                  char *const *directory_commands,
                                  guint helper_timeout_ms,
                                  gsize helper_output_limit_bytes) {
  g_autofree char *directory =
      effective_directory(arguments, path_flags, path_prefixes, argument_separator);
  g_autoptr(GHashTable) seen =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, nullptr);
  g_autoptr(GPtrArray) directories = g_ptr_array_new_null_terminated(1, g_free, true);
  g_hash_table_add(seen, g_strdup(directory));
  g_ptr_array_add(directories, g_strdup(directory));

  for (size_t index = 0; directory_commands[index] != nullptr; index++) {
    char *related =
        directory_from_command(directory_commands[index], directory, helper_timeout_ms,
                               helper_output_limit_bytes);
    if (related == nullptr) {
      continue;
    }
    if (g_hash_table_contains(seen, related)) {
      g_free(related);
      continue;
    }
    g_hash_table_add(seen, g_strdup(related));
    g_ptr_array_add(directories, related);
  }
  return (char **)g_ptr_array_steal(directories, nullptr);
}

static void append_toml_quoted(GString *output, const char *value) {
  static constexpr char hexadecimal[] = "0123456789ABCDEF";
  g_string_append_c(output, '"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0';
       cursor++) {
    switch (*cursor) {
    case '\b':
      g_string_append(output, "\\b");
      break;
    case '\t':
      g_string_append(output, "\\t");
      break;
    case '\n':
      g_string_append(output, "\\n");
      break;
    case '\f':
      g_string_append(output, "\\f");
      break;
    case '\r':
      g_string_append(output, "\\r");
      break;
    case '"':
      g_string_append(output, "\\\"");
      break;
    case '\\':
      g_string_append(output, "\\\\");
      break;
    default:
      if (*cursor < 0x20 || *cursor == 0x7f) {
        const char escape[] = {
            '\\', 'u', '0', '0', hexadecimal[*cursor >> 4], hexadecimal[*cursor & 0x0f],
            '\0',
        };
        g_string_append(output, escape);
      } else {
        g_string_append_c(output, (char)*cursor);
      }
    }
  }
  g_string_append_c(output, '"');
}

static char *toml_nested_map(const char *table, const char *field, const char *value,
                             char *const *keys) {
  g_autoptr(GString) output = g_string_new(table);
  g_string_append(output, "={");
  for (size_t index = 0; keys[index] != nullptr; index++) {
    if (index > 0) {
      g_string_append_c(output, ',');
    }
    append_toml_quoted(output, keys[index]);
    g_string_append(output, "={");
    g_string_append(output, field);
    g_string_append_c(output, '=');
    append_toml_quoted(output, value);
    g_string_append_c(output, '}');
  }
  g_string_append_c(output, '}');
  return g_string_free_and_steal(g_steal_pointer(&output));
}

char *ttr_toml_directory_context(const TtrDirectoryContextPolicy *policy,
                                 char *const *arguments) {
  g_return_val_if_fail(policy != nullptr, nullptr);
  g_return_val_if_fail(policy->toml.table != nullptr, nullptr);
  g_return_val_if_fail(policy->toml.field != nullptr, nullptr);
  g_return_val_if_fail(policy->toml.value != nullptr, nullptr);
  g_return_val_if_fail(policy->arguments.flags != nullptr, nullptr);
  g_return_val_if_fail(policy->arguments.prefixes != nullptr, nullptr);
  g_return_val_if_fail(policy->discovery.commands != nullptr, nullptr);

  g_auto(GStrv) directories = context_directories(
      arguments, policy->arguments.flags, policy->arguments.prefixes,
      policy->arguments.separator, policy->discovery.commands,
      policy->discovery.timeout_ms, policy->discovery.output_limit_bytes);
  return toml_nested_map(policy->toml.table, policy->toml.field, policy->toml.value,
                         directories);
}
