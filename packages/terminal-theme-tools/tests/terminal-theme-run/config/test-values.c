#include "config/values.h"

#include <glib.h>

static void test_named_values(void) {
  TtrThemeMode mode = TTR_THEME_LIGHT;
  g_assert_true(ttr_theme_mode_from_name("dark", &mode));
  g_assert_cmpint(mode, ==, TTR_THEME_DARK);
  g_assert_cmpstr(ttr_theme_mode_name(mode), ==, "dark");
  g_assert_false(ttr_theme_mode_from_name("unknown", &mode));
  g_assert_false(ttr_theme_mode_from_name("dark", nullptr));
  g_assert_null(ttr_theme_mode_name((TtrThemeMode)TTR_THEME_MODE_COUNT));

  TtrTemporaryLocation location = TTR_TEMPORARY_LOCATION_INVALID;
  g_assert_true(ttr_temporary_location_from_name("cache", &location));
  g_assert_cmpint(location, ==, TTR_TEMPORARY_LOCATION_CACHE);
  g_assert_false(ttr_temporary_location_from_name("cache", nullptr));

  TtrTerminalProtocol protocol = TTR_TERMINAL_PROTOCOL_INVALID;
  g_assert_true(ttr_terminal_protocol_from_name("background", &protocol));
  g_assert_cmpint(protocol, ==, TTR_TERMINAL_PROTOCOL_BACKGROUND);
  g_assert_false(ttr_terminal_protocol_from_name("background", nullptr));
}

static void test_optional_validation_name(void) {
  TtrConfigValidation validation = TTR_CONFIG_VALIDATION_TOML;
  g_assert_true(ttr_config_validation_from_name(nullptr, &validation));
  g_assert_cmpint(validation, ==, TTR_CONFIG_VALIDATION_NONE);
  validation = TTR_CONFIG_VALIDATION_TOML;
  g_assert_true(ttr_config_validation_from_name("", &validation));
  g_assert_cmpint(validation, ==, TTR_CONFIG_VALIDATION_NONE);
  g_assert_false(ttr_config_validation_from_name(nullptr, nullptr));
  g_assert_false(ttr_config_validation_from_name("", nullptr));
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  g_test_add_func("/values/named", test_named_values);
  g_test_add_func("/values/optional-validation", test_optional_validation_name);
  return g_test_run();
}
