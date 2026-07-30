#include "support/strings.h"

bool ttr_string_is_set(const char *value) { return value != nullptr && *value != '\0'; }

bool ttr_strv_contains(char *const *values, const char *value) {
  if (values == nullptr || value == nullptr) {
    return false;
  }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-qual"
  const bool contains = g_strv_contains((const char *const *)values, value);
#pragma GCC diagnostic pop
  return contains;
}

char *ttr_string_replace(const char *text, const char *placeholder,
                         const char *replacement) {
  g_return_val_if_fail(text != nullptr, nullptr);
  g_return_val_if_fail(placeholder != nullptr && *placeholder != '\0', nullptr);
  g_autoptr(GString) result = g_string_new(text);
  (void)g_string_replace(result, placeholder, replacement != nullptr ? replacement : "",
                         0);
  return g_string_free_and_steal(g_steal_pointer(&result));
}

void ttr_strv_builder_addv(GStrvBuilder *builder, char *const *values) {
  g_return_if_fail(builder != nullptr);
  if (values == nullptr) {
    return;
  }

  /*
   * GStrvBuilder's historical signature is less const-correct than
   * g_strv_contains(), although addv only reads and copies the input vector.
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
