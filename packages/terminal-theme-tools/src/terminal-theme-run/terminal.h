#ifndef TTR_TERMINAL_H
#define TTR_TERMINAL_H

#include "manifest.h"

#include <stddef.h>

typedef enum : unsigned char {
  TTR_THEME_DARK,
  TTR_THEME_LIGHT,
} TtrThemeMode;

[[nodiscard("the caller must check whether a mode was recognized")]]
bool ttr_theme_mode_from_text(const TtrRuntimeConfig *runtime, const char *text,
                              TtrThemeMode *mode);
[[nodiscard("the caller must check whether a report was recognized")]]
bool ttr_parse_terminal_report(const void *buffer, size_t length, TtrThemeMode *mode);
[[nodiscard]] TtrThemeMode ttr_detect_theme(const TtrRuntimeConfig *runtime);

#endif
