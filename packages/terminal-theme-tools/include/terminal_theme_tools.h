#ifndef TERMINAL_THEME_TOOLS_H
#define TERMINAL_THEME_TOOLS_H

#include <stddef.h>
#include <stdint.h>

#if !defined(__cplusplus) && (!defined(__STDC_VERSION__) || __STDC_VERSION__ < 202311L)
#error "terminal_theme_tools.h requires C23 or later"
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define TERMINAL_THEME_TOOLS_ABI_VERSION 1u

typedef struct terminal_theme_tools_context terminal_theme_tools_context;
typedef struct terminal_theme_tools_command terminal_theme_tools_command;

typedef struct terminal_theme_tools_string {
  const uint8_t *data;
  size_t length;
} terminal_theme_tools_string;

typedef enum terminal_theme_tools_status : int {
  TERMINAL_THEME_TOOLS_STATUS_OK = 0,
  TERMINAL_THEME_TOOLS_STATUS_INVALID_ARGUMENT = 1,
  TERMINAL_THEME_TOOLS_STATUS_OUT_OF_MEMORY = 2,
  TERMINAL_THEME_TOOLS_STATUS_INVALID_MANIFEST = 3,
  TERMINAL_THEME_TOOLS_STATUS_NOT_FOUND = 4,
  TERMINAL_THEME_TOOLS_STATUS_IO_ERROR = 5,
  TERMINAL_THEME_TOOLS_STATUS_EXECUTION_ERROR = 6,
  TERMINAL_THEME_TOOLS_STATUS_INTERNAL_ERROR = 255,
} terminal_theme_tools_status;

typedef enum terminal_theme_tools_theme : int {
  TERMINAL_THEME_TOOLS_THEME_UNKNOWN = 0,
  TERMINAL_THEME_TOOLS_THEME_DARK = 1,
  TERMINAL_THEME_TOOLS_THEME_LIGHT = 2,
} terminal_theme_tools_theme;

typedef enum terminal_theme_tools_integration_strategy : int {
  TERMINAL_THEME_TOOLS_INTEGRATION_UNKNOWN = 0,
  TERMINAL_THEME_TOOLS_INTEGRATION_ARGUMENTS = 1,
  TERMINAL_THEME_TOOLS_INTEGRATION_CONFIG = 2,
} terminal_theme_tools_integration_strategy;

/* A null environment pointer imports the process environment. A non-null
 * pointer supplies exactly environment_count NAME=VALUE strings. An empty
 * manifest uses the embedded defaults; a non-empty manifest is merged over
 * those defaults and validated. Input memory is copied. */
typedef struct terminal_theme_tools_context_options {
  terminal_theme_tools_string manifest;
  const char *const *environment;
  size_t environment_count;
} terminal_theme_tools_context_options;

uint32_t terminal_theme_tools_abi_version(void);
terminal_theme_tools_string terminal_theme_tools_version(void);
terminal_theme_tools_string
terminal_theme_tools_status_message(terminal_theme_tools_status status);

terminal_theme_tools_status
terminal_theme_tools_context_create(const terminal_theme_tools_context_options *options,
                                    terminal_theme_tools_context **out_context);
void terminal_theme_tools_context_destroy(terminal_theme_tools_context *context);
terminal_theme_tools_string
terminal_theme_tools_context_last_error(const terminal_theme_tools_context *context);

size_t terminal_theme_tools_runner_count(const terminal_theme_tools_context *context);
terminal_theme_tools_status
terminal_theme_tools_runner_find(terminal_theme_tools_context *context,
                                 const char *name, size_t *out_index);
terminal_theme_tools_string
terminal_theme_tools_runner_name(const terminal_theme_tools_context *context,
                                 size_t runner_index);
size_t
terminal_theme_tools_runner_alias_count(const terminal_theme_tools_context *context,
                                        size_t runner_index);
terminal_theme_tools_string
terminal_theme_tools_runner_alias(const terminal_theme_tools_context *context,
                                  size_t runner_index, size_t alias_index);
size_t
terminal_theme_tools_runner_program_count(const terminal_theme_tools_context *context,
                                          size_t runner_index);
terminal_theme_tools_string
terminal_theme_tools_runner_program(const terminal_theme_tools_context *context,
                                    size_t runner_index, size_t program_index);
terminal_theme_tools_string
terminal_theme_tools_runner_integration(const terminal_theme_tools_context *context,
                                        size_t runner_index);
terminal_theme_tools_string
terminal_theme_tools_runner_interpreter(const terminal_theme_tools_context *context,
                                        size_t runner_index);

size_t
terminal_theme_tools_integration_count(const terminal_theme_tools_context *context);
terminal_theme_tools_string
terminal_theme_tools_integration_name(const terminal_theme_tools_context *context,
                                      size_t integration_index);
terminal_theme_tools_integration_strategy terminal_theme_tools_integration_strategy_at(
    const terminal_theme_tools_context *context, size_t integration_index);
terminal_theme_tools_string
terminal_theme_tools_integration_theme(const terminal_theme_tools_context *context,
                                       size_t integration_index,
                                       terminal_theme_tools_theme theme);

size_t
terminal_theme_tools_interpreter_count(const terminal_theme_tools_context *context);
terminal_theme_tools_string
terminal_theme_tools_interpreter_name(const terminal_theme_tools_context *context,
                                      size_t interpreter_index);
size_t terminal_theme_tools_interpreter_program_count(
    const terminal_theme_tools_context *context, size_t interpreter_index);
terminal_theme_tools_string
terminal_theme_tools_interpreter_program(const terminal_theme_tools_context *context,
                                         size_t interpreter_index,
                                         size_t program_index);

terminal_theme_tools_theme
terminal_theme_tools_parse_terminal_report(const uint8_t *bytes, size_t length);
terminal_theme_tools_theme
terminal_theme_tools_theme_from_text(const terminal_theme_tools_context *context,
                                     const uint8_t *bytes, size_t length);
terminal_theme_tools_theme
terminal_theme_tools_detect_theme(terminal_theme_tools_context *context);

/* command is the requested executable name. arguments excludes argv[0].
 * UNKNOWN auto-detects the theme. The returned command and all of its views
 * remain valid until command_destroy; its context must outlive it. */
terminal_theme_tools_status
terminal_theme_tools_prepare(terminal_theme_tools_context *context, const char *command,
                             const char *const *arguments, size_t argument_count,
                             terminal_theme_tools_theme theme,
                             terminal_theme_tools_command **out_command);
void terminal_theme_tools_command_destroy(terminal_theme_tools_command *command);
size_t terminal_theme_tools_command_argument_count(
    const terminal_theme_tools_command *command);
terminal_theme_tools_string
terminal_theme_tools_command_argument(const terminal_theme_tools_command *command,
                                      size_t argument_index);
terminal_theme_tools_string
terminal_theme_tools_command_environment(const terminal_theme_tools_command *command,
                                         const char *name);
terminal_theme_tools_string terminal_theme_tools_command_temporary_path(
    const terminal_theme_tools_command *command);
terminal_theme_tools_status
terminal_theme_tools_command_execute(terminal_theme_tools_command *command,
                                     uint8_t *out_exit_code);

#ifdef __cplusplus
}
#endif

#endif
