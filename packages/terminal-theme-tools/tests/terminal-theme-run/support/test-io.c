#include "support/filesystem.h"
#include "support/subprocess.h"

#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <unistd.h>

static void restore_environment(const char *name, const char *value) {
  if (value == nullptr) {
    g_unsetenv(name);
  } else {
    g_setenv(name, value, true);
  }
}

static void test_platform_directories(void) {
  g_autofree char *saved_cache = g_strdup(g_getenv("XDG_CACHE_HOME"));
  g_autofree char *saved_temporary = g_strdup(g_getenv("TMPDIR"));

  g_setenv("XDG_CACHE_HOME", "/tmp/terminal-theme-run-cache-override", true);
  g_setenv("TMPDIR", "/tmp/terminal-theme-run-tmp-override", true);
  g_autofree char *cache_override = ttr_user_cache_directory();
  g_autofree char *temporary_override = ttr_user_temporary_directory();
  g_assert_cmpstr(cache_override, ==, "/tmp/terminal-theme-run-cache-override");
  g_assert_cmpstr(temporary_override, ==, "/tmp/terminal-theme-run-tmp-override");

#if defined(__APPLE__)
  g_unsetenv("XDG_CACHE_HOME");
  g_unsetenv("TMPDIR");
  g_autofree char *cache = ttr_user_cache_directory();
  g_autofree char *temporary = ttr_user_temporary_directory();
  const size_t cache_size = confstr(_CS_DARWIN_USER_CACHE_DIR, nullptr, 0);
  const size_t temporary_size = confstr(_CS_DARWIN_USER_TEMP_DIR, nullptr, 0);
  g_autofree char *expected_cache = g_malloc(cache_size);
  g_autofree char *expected_temporary = g_malloc(temporary_size);
  g_assert_cmpuint(confstr(_CS_DARWIN_USER_CACHE_DIR, expected_cache, cache_size), >,
                   0);
  g_assert_cmpuint(
      confstr(_CS_DARWIN_USER_TEMP_DIR, expected_temporary, temporary_size), >, 0);
  g_assert_cmpstr(cache, ==, expected_cache);
  g_assert_cmpstr(temporary, ==, expected_temporary);
#endif

  restore_environment("XDG_CACHE_HOME", saved_cache);
  restore_environment("TMPDIR", saved_temporary);
}

static void test_regular_file_boundaries(void) {
  g_autoptr(GError) error = nullptr;
  g_autofree char *temporary =
      g_dir_make_tmp("terminal-theme-run-io-test-XXXXXX", &error);
  g_assert_no_error(error);
  g_autofree char *path = g_build_filename(temporary, "input", nullptr);
  g_assert_true(g_file_set_contents(path, "12345", -1, &error));
  g_assert_no_error(error);

  g_autofree char *contents = nullptr;
  gsize length = 0;
  g_assert_cmpint(ttr_read_regular_file(path, 5, &contents, &length, &error), ==,
                  TTR_FILE_READ_OK);
  g_assert_no_error(error);
  g_assert_cmpuint(length, ==, 5);
  g_assert_cmpstr(contents, ==, "12345");

  g_clear_pointer(&contents, g_free);
  length = 0;
  g_assert_cmpint(ttr_read_regular_file(path, 4, &contents, &length, &error), ==,
                  TTR_FILE_READ_ERROR);
  g_assert_error(error, G_IO_ERROR, G_IO_ERROR_MESSAGE_TOO_LARGE);
  g_assert_nonnull(g_strstr_len(error->message, -1, "size limit"));
  g_assert_null(contents);
  g_assert_cmpuint(length, ==, 0);
  g_clear_error(&error);

  g_assert_cmpint(ttr_read_regular_file(temporary, 5, &contents, &length, &error), ==,
                  TTR_FILE_READ_ERROR);
  g_assert_error(error, G_IO_ERROR, G_IO_ERROR_NOT_REGULAR_FILE);
  g_assert_nonnull(g_strstr_len(error->message, -1, "not a regular file"));
  g_clear_error(&error);

  g_autofree char *missing = g_build_filename(temporary, "missing", nullptr);
  g_assert_cmpint(ttr_read_regular_file(missing, 5, &contents, &length, &error), ==,
                  TTR_FILE_READ_NOT_FOUND);
  g_assert_no_error(error);

  g_assert_cmpint(g_remove(path), ==, 0);
  g_assert_cmpint(g_rmdir(temporary), ==, 0);
}

static void test_subprocess_capture(void) {
  static const char *const arguments[] = {
      "/bin/sh",
      "-c",
      "printf hello",
      nullptr,
  };
  g_autoptr(GError) error = nullptr;
  g_autofree char *output = nullptr;
  bool successful = false;
  g_assert_true(
      ttr_subprocess_capture_stdout(arguments, 1000, 32, &output, &successful, &error));
  g_assert_no_error(error);
  g_assert_true(successful);
  g_assert_cmpstr(output, ==, "hello");
}

static void test_subprocess_output_limit(void) {
  static const char *const arguments[] = {
      "/bin/sh",
      "-c",
      "printf 12345",
      nullptr,
  };
  g_autoptr(GError) error = nullptr;
  g_autofree char *output = nullptr;
  bool successful = false;
  g_assert_false(
      ttr_subprocess_capture_stdout(arguments, 1000, 4, &output, &successful, &error));
  g_assert_error(error, G_IO_ERROR, G_IO_ERROR_MESSAGE_TOO_LARGE);
  g_assert_nonnull(g_strstr_len(error->message, -1, "size limit"));
  g_assert_null(output);
  g_assert_false(successful);
}

static void test_subprocess_rejects_non_text(void) {
  static const char *const arguments[] = {
      "/bin/sh",
      "-c",
      "printf '\\377'",
      nullptr,
  };
  g_autoptr(GError) error = nullptr;
  g_autofree char *output = nullptr;
  bool successful = false;
  g_assert_false(
      ttr_subprocess_capture_stdout(arguments, 1000, 32, &output, &successful, &error));
  g_assert_error(error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA);
  g_assert_nonnull(g_strstr_len(error->message, -1, "valid UTF-8 text"));
  g_assert_null(output);
  g_assert_false(successful);
}

static void test_subprocess_timeout(void) {
  static const char *const arguments[] = {
      "/bin/sh",
      "-c",
      "while :; do :; done",
      nullptr,
  };
  g_autoptr(GError) error = nullptr;
  g_autofree char *output = nullptr;
  bool successful = false;
  g_assert_false(
      ttr_subprocess_capture_stdout(arguments, 10, 32, &output, &successful, &error));
  g_assert_error(error, G_IO_ERROR, G_IO_ERROR_TIMED_OUT);
  g_assert_null(output);
  g_assert_false(successful);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  g_test_add_func("/io/platform-directories", test_platform_directories);
  g_test_add_func("/io/regular-file", test_regular_file_boundaries);
  g_test_add_func("/io/capture/success", test_subprocess_capture);
  g_test_add_func("/io/capture/output-limit", test_subprocess_output_limit);
  g_test_add_func("/io/capture/non-text", test_subprocess_rejects_non_text);
  g_test_add_func("/io/capture/timeout", test_subprocess_timeout);
  return g_test_run();
}
