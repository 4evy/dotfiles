#include "support/test-support.h"

#include "config/toml-schema.h"
#include "theme/context.h"

#include <glib.h>
#include <glib/gstdio.h>
#include <string.h>
#include <tomlc17.h>

static void assert_context_target(toml_datum_t contexts, const char *target) {
  const toml_datum_t context = toml_get(contexts, target);
  g_assert_cmpint(context.type, ==, TOML_TABLE);
  const toml_datum_t access = toml_get(context, "access");
  g_assert_cmpint(access.type, ==, TOML_STRING);
  g_assert_cmpstr(access.u.s, ==, "allowed");
}

static void test_directory_context_uses_manifest_policy(void) {
  char *path_flags[] = {
      TTR_MUTABLE_STRING("-C"),
      TTR_MUTABLE_STRING("--cd"),
      nullptr,
  };
  char *path_prefixes[] = {
      TTR_MUTABLE_STRING("-C"),
      TTR_MUTABLE_STRING("--cd="),
      nullptr,
  };
  char *commands[] = {
      TTR_MUTABLE_STRING("dirname {directory}"),
      nullptr,
  };
  g_autoptr(GError) error = nullptr;
  g_autofree char *temporary =
      g_dir_make_tmp("terminal-theme-run-context-test-XXXXXX", &error);
  g_assert_no_error(error);
  g_autofree char *nested = g_build_filename(temporary, "nested", nullptr);
  g_assert_cmpint(g_mkdir(nested, 0755), ==, 0);

  char *arguments[] = {
      TTR_MUTABLE_STRING("--cd"),
      nested,
      nullptr,
  };
  const TtrDirectoryContextPolicy policy = {
      .toml =
          {
              .table = "workspaces",
              .field = "access",
              .value = "allowed",
          },
      .arguments =
          {
              .flags = path_flags,
              .prefixes = path_prefixes,
              .separator = "--",
          },
      .discovery =
          {
              .commands = commands,
              .timeout_ms = 2000,
              .output_limit_bytes = 65536,
          },
  };
  g_autofree char *rendered = ttr_toml_directory_context(&policy, arguments);
  g_auto(toml_result_t) parsed = toml_parse(rendered, (int)strlen(rendered));
  g_assert_true(parsed.ok);
  const toml_datum_t workspaces = toml_get(parsed.toptab, "workspaces");
  g_assert_cmpint(workspaces.type, ==, TOML_TABLE);
  assert_context_target(workspaces, nested);
  assert_context_target(workspaces, temporary);

  g_assert_cmpint(g_rmdir(nested), ==, 0);
  g_assert_cmpint(g_rmdir(temporary), ==, 0);
}

static void test_directory_context_honors_separator(void) {
  char *path_flags[] = {
      TTR_MUTABLE_STRING("-C"),
      nullptr,
  };
  char *path_prefixes[] = {
      TTR_MUTABLE_STRING("-C"),
      nullptr,
  };
  char *empty[] = {nullptr};
  g_autofree char *current = g_get_current_dir();
  char *arguments[] = {
      TTR_MUTABLE_STRING("--"),
      TTR_MUTABLE_STRING("-C"),
      TTR_MUTABLE_STRING("/tmp/ignored"),
      nullptr,
  };
  const TtrDirectoryContextPolicy policy = {
      .toml =
          {
              .table = "workspaces",
              .field = "access",
              .value = "allowed",
          },
      .arguments =
          {
              .flags = path_flags,
              .prefixes = path_prefixes,
              .separator = "--",
          },
      .discovery =
          {
              .commands = empty,
          },
  };
  g_autofree char *rendered = ttr_toml_directory_context(&policy, arguments);
  g_auto(toml_result_t) parsed = toml_parse(rendered, (int)strlen(rendered));
  g_assert_true(parsed.ok);
  const toml_datum_t workspaces = toml_get(parsed.toptab, "workspaces");
  g_assert_cmpint(workspaces.type, ==, TOML_TABLE);
  assert_context_target(workspaces, current);
  g_assert_cmpint(workspaces.u.tab.size, ==, 1);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  g_test_add_func("/context/manifest-policy",
                  test_directory_context_uses_manifest_policy);
  g_test_add_func("/context/separator", test_directory_context_honors_separator);
  return g_test_run();
}
