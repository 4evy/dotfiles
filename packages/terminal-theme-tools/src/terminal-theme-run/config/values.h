#ifndef TTR_CONFIG_VALUES_H
#define TTR_CONFIG_VALUES_H

#include <glib.h>

typedef enum : unsigned char {
  TTR_THEME_DARK,
  TTR_THEME_LIGHT,
  TTR_THEME_MODE_COUNT,
} TtrThemeMode;

typedef enum : unsigned char {
  TTR_TEMPORARY_LOCATION_INVALID,
  TTR_TEMPORARY_LOCATION_SYSTEM,
  TTR_TEMPORARY_LOCATION_CACHE,
  TTR_TEMPORARY_LOCATION_COUNT,
} TtrTemporaryLocation;

typedef enum : unsigned char {
  TTR_CONFIG_VALIDATION_NONE,
  TTR_CONFIG_VALIDATION_TOML,
  TTR_CONFIG_VALIDATION_COUNT,
} TtrConfigValidation;

typedef enum : unsigned char {
  TTR_TERMINAL_PROTOCOL_INVALID,
  TTR_TERMINAL_PROTOCOL_BACKGROUND,
  TTR_TERMINAL_PROTOCOL_COLOR_SCHEME,
  TTR_TERMINAL_PROTOCOL_COUNT,
} TtrTerminalProtocol;

extern const char ttr_context_placeholder[];
extern const char ttr_directory_placeholder[];
extern const char ttr_terminal_protocol_fallback_key[];
extern const char ttr_theme_placeholder[];
extern const char ttr_temporary_template_suffix[];

[[nodiscard("the caller must check whether a mode was recognized")]]
bool ttr_theme_mode_from_name(const char *name, TtrThemeMode *mode);
[[nodiscard]] const char *ttr_theme_mode_name(TtrThemeMode mode);

[[nodiscard("the caller must check whether a location was recognized")]]
bool ttr_temporary_location_from_name(const char *name, TtrTemporaryLocation *location);

[[nodiscard("the caller must check whether a validation mode was recognized")]]
bool ttr_config_validation_from_name(const char *name, TtrConfigValidation *validation);

[[nodiscard("the caller must check whether a protocol was recognized")]]
bool ttr_terminal_protocol_from_name(const char *name, TtrTerminalProtocol *protocol);

#endif
