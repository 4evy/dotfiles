#include "trust.h"

#include "util.h"

#include <git2.h>
#include <string.h>

G_DEFINE_AUTOPTR_CLEANUP_FUNC(git_repository, git_repository_free)

static const char *joined_value(char *const *prefixes, const char *argument) {
  for (size_t index = 0; prefixes[index] != nullptr; index++) {
    const size_t length = strlen(prefixes[index]);
    if (g_str_has_prefix(argument, prefixes[index]) && argument[length] != '\0') {
      return argument + length;
    }
  }
  return nullptr;
}

static const char *cwd_override(char *const *arguments, char *const *cwd_flags,
                                char *const *cwd_prefixes) {
  const char *override = nullptr;
  if (arguments == nullptr) {
    return nullptr;
  }
  for (size_t index = 0; arguments[index] != nullptr; index++) {
    const char *argument = arguments[index];
    if (g_str_equal(argument, "--")) {
      break;
    }
    if (ttr_strv_contains(cwd_flags, argument)) {
      if (arguments[index + 1] != nullptr) {
        override = arguments[++index];
      }
      continue;
    }
    const char *joined = joined_value(cwd_prefixes, argument);
    if (joined != nullptr) {
      override = joined;
    }
  }
  return override;
}

char *ttr_resolve_launch_cwd(char *const *arguments, char *const *cwd_flags,
                             char *const *cwd_prefixes) {
  g_return_val_if_fail(cwd_flags != nullptr, nullptr);
  g_return_val_if_fail(cwd_prefixes != nullptr, nullptr);
  char *current = g_get_current_dir();
  const char *override = cwd_override(arguments, cwd_flags, cwd_prefixes);
  if (override == nullptr) {
    return current;
  }
  char *resolved = g_canonicalize_filename(override, current);
  g_free(current);
  return resolved;
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

static char *toml_trust_override(const char *table, const char *field,
                                 const char *value, char *const *trust_targets) {
  g_autoptr(GString) output = g_string_new(table);
  g_string_append(output, "={");
  if (trust_targets != nullptr) {
    for (size_t index = 0; trust_targets[index] != nullptr; index++) {
      if (index > 0) {
        g_string_append_c(output, ',');
      }
      append_toml_quoted(output, trust_targets[index]);
      g_string_append(output, "={");
      g_string_append(output, field);
      g_string_append_c(output, '=');
      append_toml_quoted(output, value);
      g_string_append_c(output, '}');
    }
  }
  g_string_append_c(output, '}');
  return g_string_free_and_steal(g_steal_pointer(&output));
}

static char *git_root(const char *directory) {
  if (git_libgit2_init() < 0) {
    return nullptr;
  }

  g_autoptr(git_repository) repository = nullptr;
  char *root = nullptr;
  if (git_repository_open_ext(&repository, directory, 0, nullptr) == 0) {
    const char *worktree = git_repository_workdir(repository);
    if (worktree != nullptr) {
      root = g_canonicalize_filename(worktree, nullptr);
    }
  }
  (void)git_libgit2_shutdown();
  return root;
}

char *ttr_toml_worktree_trust_override(const char *table, const char *field,
                                       const char *value, char *const *arguments,
                                       char *const *cwd_flags,
                                       char *const *cwd_prefixes) {
  g_return_val_if_fail(table != nullptr, nullptr);
  g_return_val_if_fail(field != nullptr, nullptr);
  g_return_val_if_fail(value != nullptr, nullptr);

  g_autofree char *launch_cwd =
      ttr_resolve_launch_cwd(arguments, cwd_flags, cwd_prefixes);
  g_autofree char *root = git_root(launch_cwd);
  char *targets[3] = {launch_cwd, nullptr, nullptr};
  if (root != nullptr && !g_str_equal(root, launch_cwd)) {
    targets[1] = root;
  }
  return toml_trust_override(table, field, value, targets);
}
