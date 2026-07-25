#include "terminal.h"

#include <glib.h>
#include <string.h>

static TtrManifest *test_manifest;

static void test_terminal_reports(void) {
  static const struct {
    const char *report;
    TtrThemeMode expected;
  } cases[] = {
      {"\x1b[?997;1n", TTR_THEME_DARK},
      {"\x1b[?997;2n", TTR_THEME_LIGHT},
      {"\x1b]11;rgb:efff/f1f1/f5f5\a", TTR_THEME_LIGHT},
      {"prefix\x1b]11;rgb:3030/3434/4646\x1b\\suffix", TTR_THEME_DARK},
      {"\x1b]11;rgb:ef/f1/f5\a", TTR_THEME_LIGHT},
      {"\x1b]11;rgb:30/34/46\a", TTR_THEME_DARK},
      {"\x1b]11;rgb:80/80/80\a", TTR_THEME_LIGHT},
      {"\x1b]11;rgb:7f/7f/7f\a", TTR_THEME_DARK},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(cases); index++) {
    TtrThemeMode mode;
    g_assert_true(ttr_parse_terminal_report(cases[index].report,
                                            strlen(cases[index].report), &mode));
    g_assert_cmpint(mode, ==, cases[index].expected);
  }
}

static void test_terminal_report_rejects_invalid_components(void) {
  static const char *const invalid[] = {
      "\x1b]11;rgb:/ff/ff\a",
      "\x1b]11;rgb:fffff/ff/ff\a",
      "\x1b]11;rgb:gg/ff/ff\a",
      "\x1b]11;rgb:ff/ff/ff/ff\a",
      "\x1b[997;1n",
      "\x1b[?997;1;2n",
      "\x1b[?997;1m",
      "\x1b]11;rgb:ff/ff/ff",
  };
  for (size_t index = 0; index < G_N_ELEMENTS(invalid); index++) {
    TtrThemeMode mode;
    g_assert_false(
        ttr_parse_terminal_report(invalid[index], strlen(invalid[index]), &mode));
  }
}

static void test_theme_mode_from_text(void) {
  TtrThemeMode mode;
  const TtrRuntimeConfig *runtime = ttr_manifest_runtime(test_manifest);
  g_assert_false(ttr_theme_mode_from_text(runtime, "'default'", &mode));
  g_assert_false(ttr_theme_mode_from_text(runtime, "'Adwaita'", &mode));
  g_assert_true(ttr_theme_mode_from_text(runtime, "'Adwaita-dark'", &mode));
  g_assert_cmpint(mode, ==, TTR_THEME_DARK);
  g_assert_true(ttr_theme_mode_from_text(runtime, "catppuccin-latte-pink", &mode));
  g_assert_cmpint(mode, ==, TTR_THEME_LIGHT);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  GError *error = nullptr;
  test_manifest = ttr_manifest_load(&error);
  g_assert_no_error(error);
  g_assert_nonnull(test_manifest);
  g_test_add_func("/terminal/reports", test_terminal_reports);
  g_test_add_func("/terminal/invalid-components",
                  test_terminal_report_rejects_invalid_components);
  g_test_add_func("/terminal/text", test_theme_mode_from_text);
  const int status = g_test_run();
  ttr_manifest_free(test_manifest);
  return status;
}
