#include "context.h"

#include "util.h"

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

static char *replace_placeholder(const char *text, const char *placeholder,
                                 const char *value) {
  g_auto(GStrv) parts = g_strsplit(text, placeholder, -1);
  return g_strjoinv(value, parts);
}

static char *directory_from_command(const char *command, const char *directory) {
  int argument_count = 0;
  g_auto(GStrv) arguments = nullptr;
  if (!g_shell_parse_argv(command, &argument_count, &arguments, nullptr) ||
      argument_count == 0) {
    return nullptr;
  }
  for (int index = 0; index < argument_count; index++) {
    char *expanded = replace_placeholder(arguments[index], "{directory}", directory);
    g_free(arguments[index]);
    arguments[index] = expanded;
  }

  g_autoptr(GSubprocess) process = g_subprocess_newv(
      (const char *const *)arguments,
      G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_SILENCE, nullptr);
  if (process == nullptr) {
    return nullptr;
  }
  g_autofree char *output = nullptr;
  if (!g_subprocess_communicate_utf8(process, nullptr, nullptr, &output, nullptr,
                                     nullptr) ||
      !g_subprocess_get_successful(process) || output == nullptr) {
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
                                  char *const *directory_commands) {
  g_autofree char *directory =
      effective_directory(arguments, path_flags, path_prefixes, argument_separator);
  g_autoptr(GHashTable) seen =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, nullptr);
  g_autoptr(GPtrArray) directories = g_ptr_array_new_null_terminated(1, g_free, true);
  g_hash_table_add(seen, g_strdup(directory));
  g_ptr_array_add(directories, g_strdup(directory));

  for (size_t index = 0; directory_commands[index] != nullptr; index++) {
    char *related = directory_from_command(directory_commands[index], directory);
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

char *ttr_toml_directory_context(const char *table, const char *field,
                                 const char *value, char *const *arguments,
                                 char *const *path_flags, char *const *path_prefixes,
                                 const char *argument_separator,
                                 char *const *directory_commands) {
  g_return_val_if_fail(table != nullptr, nullptr);
  g_return_val_if_fail(field != nullptr, nullptr);
  g_return_val_if_fail(value != nullptr, nullptr);
  g_return_val_if_fail(path_flags != nullptr, nullptr);
  g_return_val_if_fail(path_prefixes != nullptr, nullptr);
  g_return_val_if_fail(directory_commands != nullptr, nullptr);

  g_auto(GStrv) directories = context_directories(
      arguments, path_flags, path_prefixes, argument_separator, directory_commands);
  return toml_nested_map(table, field, value, directories);
}
