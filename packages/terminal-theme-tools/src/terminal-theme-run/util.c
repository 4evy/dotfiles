#include "util.h"

const char *ttr_home_directory(void) {
  const char *home = g_getenv("HOME");
  return home != nullptr && *home != '\0' ? home : g_get_home_dir();
}

char *ttr_expand_path(const char *path) {
  const char *home = ttr_home_directory();
  if (home == nullptr || path == nullptr) {
    return g_strdup(path);
  }
  if (g_str_equal(path, "~")) {
    return g_strdup(home);
  }
  if (g_str_has_prefix(path, "~/")) {
    return g_build_filename(home, path + 2, nullptr);
  }
  return g_strdup(path);
}

bool ttr_string_is_set(const char *value) { return value != nullptr && *value != '\0'; }

bool ttr_strv_contains(char *const *values, const char *value) {
  if (values == nullptr || value == nullptr) {
    return false;
  }
  for (size_t index = 0; values[index] != nullptr; index++) {
    if (g_str_equal(values[index], value)) {
      return true;
    }
  }
  return false;
}

void ttr_strv_builder_addv(GStrvBuilder *builder, char *const *values) {
  g_return_if_fail(builder != nullptr);
  if (values == nullptr) {
    return;
  }

  /*
   * GStrvBuilder predates the const-correct GStrv typedef and accepts
   * `const char **`, although it only reads the vector. Keep that cast in this
   * single adapter instead of weakening every caller's types.
   */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-qual"
  g_strv_builder_addv(builder, (const char **)values);
#pragma GCC diagnostic pop
}

char **ttr_strv_concat(char *const *left, char *const *right) {
  g_autoptr(GStrvBuilder) output = g_strv_builder_new();
  ttr_strv_builder_addv(output, left);
  ttr_strv_builder_addv(output, right);
  return g_strv_builder_end(output);
}
