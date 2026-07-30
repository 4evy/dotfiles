#include "config.h"
#include "config/manifest.h"
#include "launch/runner.h"

#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static constexpr char help_command[] = "help";
static constexpr char option_parameter_string[] = "COMMAND [ARG...]";
static constexpr char program_summary[] = "Run terminal theme helpers";

static char *command_help(const TtrManifest *manifest) {
  g_auto(GStrv) names = ttr_manifest_program_names(manifest);
  g_autoptr(GString) help = g_string_new("Available commands:\n");
  for (size_t index = 0; names[index] != nullptr; index++) {
    g_string_append_printf(help, "  %-12s Run %s with terminal theme integration\n",
                           names[index], names[index]);
  }
  return g_string_free_and_steal(g_steal_pointer(&help));
}

static void print_help(GOptionContext *context) {
  g_autofree char *help = g_option_context_get_help(context, true, nullptr);
  fputs(help, stdout);
}

int main(int argc, char **argv) {
  g_autoptr(GError) error = nullptr;
  g_autoptr(TtrManifest) manifest = ttr_manifest_load(&error);
  if (manifest == nullptr) {
    fprintf(stderr, "Error: %s\n", error->message);
    return EXIT_FAILURE;
  }

  gboolean show_version = false;
  const GOptionEntry options[] = {
      {
          .long_name = "version",
          .arg = G_OPTION_ARG_NONE,
          .arg_data = &show_version,
          .description = "Show program version",
      },
      {},
  };
  g_autofree char *description = command_help(manifest);
  g_autoptr(GOptionContext) context = g_option_context_new(option_parameter_string);
  g_option_context_set_summary(context, program_summary);
  g_option_context_set_description(context, description);
  g_option_context_set_strict_posix(context, true);
  g_option_context_add_main_entries(context, options, nullptr);
  if (!g_option_context_parse(context, &argc, &argv, &error)) {
    fprintf(stderr, "Error: %s\n", error->message);
    return EXIT_FAILURE;
  }

  if (show_version) {
    printf("terminal-theme-run version %s\n", TTR_VERSION);
    return EXIT_SUCCESS;
  }
  if (argc < 2) {
    print_help(context);
    return EXIT_SUCCESS;
  }
  if (g_str_equal(argv[1], help_command)) {
    print_help(context);
    return EXIT_SUCCESS;
  }

  const TtrRunner *runner = ttr_manifest_find(manifest, argv[1]);
  if (runner == nullptr) {
    fprintf(stderr, "Error: unknown command %s\n", argv[1]);
    return EXIT_FAILURE;
  }
  const TtrIntegration *integration =
      ttr_manifest_find_integration(manifest, runner->integration);
  const int status = ttr_runner_run(runner, integration, ttr_manifest_runtime(manifest),
                                    argv + 2, &error);
  if (error != nullptr) {
    fprintf(stderr, "Error: %s\n", error->message);
  }
  return status;
}
