#ifndef TTR_UTIL_H
#define TTR_UTIL_H

#include <glib.h>

[[nodiscard("the returned path must be freed")]]
char *ttr_expand_path(const char *path);
[[nodiscard]] const char *ttr_home_directory(void);

[[nodiscard]] bool ttr_string_is_set(const char *value);
[[nodiscard]] bool ttr_strv_contains(char *const *values, const char *value);
void ttr_strv_builder_addv(GStrvBuilder *builder, char *const *values);
[[nodiscard("the returned string vector must be freed")]]
char **ttr_strv_concat(char *const *left, char *const *right);

#endif
