#ifndef TTR_SUPPORT_STRINGS_H
#define TTR_SUPPORT_STRINGS_H

#include <glib.h>

[[nodiscard]] bool ttr_string_is_set(const char *value);
[[nodiscard]] bool ttr_strv_contains(char *const *values, const char *value);
[[nodiscard("the returned string must be freed")]]
char *ttr_string_replace(const char *text, const char *placeholder,
                         const char *replacement);
void ttr_strv_builder_addv(GStrvBuilder *builder, char *const *values);
[[nodiscard("the returned string vector must be freed")]]
char **ttr_strv_concat(char *const *left, char *const *right);

#endif
