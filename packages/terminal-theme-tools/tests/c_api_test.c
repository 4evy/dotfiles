#include "terminal_theme_tools.h"

#include <assert.h>
#include <string.h>

static_assert(sizeof(terminal_theme_tools_status) == sizeof(int));
static_assert(sizeof(terminal_theme_tools_theme) == sizeof(int));
static_assert(sizeof(terminal_theme_tools_integration_strategy) == sizeof(int));

static bool string_equals(terminal_theme_tools_string value, const char *expected) {
  const size_t length = strlen(expected);
  return value.length == length && value.data != nullptr &&
         memcmp(value.data, expected, length) == 0;
}

int main(void) {
  static const uint8_t dark_report[] = "\x1b[?997;1n";
  static const uint8_t light_report[] = "\x1b]11;rgb:ffff/ffff/ffff\x07";
  static const uint8_t manifest[] = "[[interpreter]]\n"
                                    "name = \"c-api-interpreter\"\n"
                                    "shebang_commands = [\"/usr/bin/env\"]\n"
                                    "shebang_arguments = [\"sh\"]\n"
                                    "programs = [\"/bin/sh\"]\n"
                                    "[[integration]]\n"
                                    "name = \"c-api-integration\"\n"
                                    "strategy = \"arguments\"\n"
                                    "dark_theme = \"dark\"\n"
                                    "light_theme = \"light\"\n"
                                    "arguments = [\"--theme\", \"{theme}\"]\n"
                                    "[[runner]]\n"
                                    "name = \"c-api-shell\"\n"
                                    "programs = [\"/bin/sh\"]\n"
                                    "env = { C_API_CHILD = \"configured\" }\n";
  static const char *const environment[] = {
      "PATH=/usr/bin:/bin",
      "COLOR_SCHEME=dark",
  };
  const terminal_theme_tools_context_options options = {
      .manifest = {manifest, sizeof(manifest) - 1u},
      .environment = environment,
      .environment_count = sizeof(environment) / sizeof(environment[0]),
  };
  terminal_theme_tools_context *context = nullptr;

  assert(terminal_theme_tools_abi_version() == TERMINAL_THEME_TOOLS_ABI_VERSION);
  assert(string_equals(terminal_theme_tools_version(), "0.3.0"));
  assert(terminal_theme_tools_context_create(&options, &context) ==
         TERMINAL_THEME_TOOLS_STATUS_OK);
  assert(context != nullptr);
  assert(terminal_theme_tools_runner_count(context) >= 1u);
  assert(terminal_theme_tools_integration_count(context) >= 1u);
  assert(terminal_theme_tools_interpreter_count(context) >= 1u);

  size_t runner_index = 0u;
  assert(terminal_theme_tools_runner_find(context, "c-api-shell", &runner_index) ==
         TERMINAL_THEME_TOOLS_STATUS_OK);
  assert(string_equals(terminal_theme_tools_runner_name(context, runner_index),
                       "c-api-shell"));
  assert(string_equals(terminal_theme_tools_runner_program(context, runner_index, 0u),
                       "/bin/sh"));
  assert(terminal_theme_tools_runner_find(context, "missing-runner", &runner_index) ==
         TERMINAL_THEME_TOOLS_STATUS_NOT_FOUND);
  assert(terminal_theme_tools_context_last_error(context).length > 0u);

  assert(terminal_theme_tools_parse_terminal_report(
             dark_report, sizeof(dark_report) - 1u) == TERMINAL_THEME_TOOLS_THEME_DARK);
  assert(terminal_theme_tools_parse_terminal_report(light_report,
                                                    sizeof(light_report) - 1u) ==
         TERMINAL_THEME_TOOLS_THEME_LIGHT);
  assert(terminal_theme_tools_parse_terminal_report(nullptr, 0u) ==
         TERMINAL_THEME_TOOLS_THEME_UNKNOWN);
  assert(terminal_theme_tools_theme_from_text(context, (const uint8_t *)"dark", 4u) ==
         TERMINAL_THEME_TOOLS_THEME_DARK);
  assert(terminal_theme_tools_detect_theme(context) == TERMINAL_THEME_TOOLS_THEME_DARK);

  static const char *const arguments[] = {"-c", "exit 7"};
  terminal_theme_tools_command *command = nullptr;
  assert(terminal_theme_tools_prepare(context, "c-api-shell", arguments,
                                      sizeof(arguments) / sizeof(arguments[0]),
                                      TERMINAL_THEME_TOOLS_THEME_DARK,
                                      &command) == TERMINAL_THEME_TOOLS_STATUS_OK);
  assert(command != nullptr);
  assert(terminal_theme_tools_command_argument_count(command) == 3u);
  assert(string_equals(terminal_theme_tools_command_argument(command, 0u), "/bin/sh"));
  assert(string_equals(terminal_theme_tools_command_environment(command, "C_API_CHILD"),
                       "configured"));
  assert(string_equals(
      terminal_theme_tools_command_environment(command, "TERMINAL_THEME_RUN_ACTIVE"),
      "1"));
  assert(terminal_theme_tools_command_temporary_path(command).length == 0u);

  uint8_t exit_code = 0u;
  assert(terminal_theme_tools_command_execute(command, &exit_code) ==
         TERMINAL_THEME_TOOLS_STATUS_OK);
  assert(exit_code == 7u);

  terminal_theme_tools_command_destroy(command);
  terminal_theme_tools_context_destroy(context);
  return 0;
}
