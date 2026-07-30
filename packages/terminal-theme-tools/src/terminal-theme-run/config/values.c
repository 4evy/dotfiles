#include "config/values.h"

#include "support/strings.h"

typedef struct {
  const char *name;
  unsigned char value;
} NamedValue;

const char ttr_context_placeholder[] = "{context}";
const char ttr_directory_placeholder[] = "{directory}";
const char ttr_terminal_protocol_fallback_key[] = "*";
const char ttr_theme_placeholder[] = "{theme}";
const char ttr_temporary_template_suffix[] = "XXXXXX";

static const NamedValue theme_modes[] = {
    {
        .name = "dark",
        .value = TTR_THEME_DARK,
    },
    {
        .name = "light",
        .value = TTR_THEME_LIGHT,
    },
};

static const NamedValue temporary_locations[] = {
    {
        .name = "system",
        .value = TTR_TEMPORARY_LOCATION_SYSTEM,
    },
    {
        .name = "cache",
        .value = TTR_TEMPORARY_LOCATION_CACHE,
    },
};

static const NamedValue config_validations[] = {
    {
        .name = "toml",
        .value = TTR_CONFIG_VALIDATION_TOML,
    },
};

static const NamedValue terminal_protocols[] = {
    {
        .name = "background",
        .value = TTR_TERMINAL_PROTOCOL_BACKGROUND,
    },
    {
        .name = "color-scheme",
        .value = TTR_TERMINAL_PROTOCOL_COLOR_SCHEME,
    },
};

static_assert(G_N_ELEMENTS(theme_modes) == TTR_THEME_MODE_COUNT);
static_assert(G_N_ELEMENTS(temporary_locations) + 1 == TTR_TEMPORARY_LOCATION_COUNT);
static_assert(G_N_ELEMENTS(config_validations) + 1 == TTR_CONFIG_VALIDATION_COUNT);
static_assert(G_N_ELEMENTS(terminal_protocols) + 1 == TTR_TERMINAL_PROTOCOL_COUNT);

static bool named_value_from_name(const NamedValue *values, size_t value_count,
                                  const char *name, unsigned char *value) {
  if (name == nullptr || value == nullptr) {
    return false;
  }
  for (size_t index = 0; index < value_count; index++) {
    if (g_str_equal(name, values[index].name)) {
      *value = values[index].value;
      return true;
    }
  }
  return false;
}

bool ttr_theme_mode_from_name(const char *name, TtrThemeMode *mode) {
  if (mode == nullptr) {
    return false;
  }
  unsigned char value = 0;
  if (!named_value_from_name(theme_modes, G_N_ELEMENTS(theme_modes), name, &value)) {
    return false;
  }
  *mode = (TtrThemeMode)value;
  return true;
}

const char *ttr_theme_mode_name(TtrThemeMode mode) {
  if (mode >= TTR_THEME_MODE_COUNT) {
    return nullptr;
  }
  return theme_modes[mode].name;
}

bool ttr_temporary_location_from_name(const char *name,
                                      TtrTemporaryLocation *location) {
  if (location == nullptr) {
    return false;
  }
  unsigned char value = 0;
  if (!named_value_from_name(temporary_locations, G_N_ELEMENTS(temporary_locations),
                             name, &value)) {
    return false;
  }
  *location = (TtrTemporaryLocation)value;
  return true;
}

bool ttr_config_validation_from_name(const char *name,
                                     TtrConfigValidation *validation) {
  if (validation == nullptr) {
    return false;
  }
  if (!ttr_string_is_set(name)) {
    *validation = TTR_CONFIG_VALIDATION_NONE;
    return true;
  }
  unsigned char value = 0;
  if (!named_value_from_name(config_validations, G_N_ELEMENTS(config_validations), name,
                             &value)) {
    return false;
  }
  *validation = (TtrConfigValidation)value;
  return true;
}

bool ttr_terminal_protocol_from_name(const char *name, TtrTerminalProtocol *protocol) {
  if (protocol == nullptr) {
    return false;
  }
  unsigned char value = 0;
  if (!named_value_from_name(terminal_protocols, G_N_ELEMENTS(terminal_protocols), name,
                             &value)) {
    return false;
  }
  *protocol = (TtrTerminalProtocol)value;
  return true;
}
