#ifndef TTR_THEME_TERMINAL_H
#define TTR_THEME_TERMINAL_H

#include "config/manifest.h"

#include <stddef.h>

[[nodiscard("the caller must check whether a mode was recognized")]]
bool ttr_theme_mode_from_text(const TtrRuntimeConfig *runtime, const char *text,
                              TtrThemeMode *mode);
[[nodiscard("the caller must check whether a report was recognized")]]
bool ttr_parse_terminal_report(const void *buffer, size_t length, TtrThemeMode *mode);
[[nodiscard]] const char *ttr_terminal_theme_query(const TtrRuntimeConfig *runtime);
[[nodiscard]] TtrThemeMode ttr_detect_theme(const TtrRuntimeConfig *runtime);

#endif
