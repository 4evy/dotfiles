#include "runner.h"

#include "terminal.h"
#include "theme.h"
#include "util.h"

#include <gio/gio.h>
#include <string.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

static GQuark runner_error_quark(void) {
  return g_quark_from_static_string("terminal-theme-run-runner-error");
}

static bool is_path_like(const char *name) {
  return g_path_is_absolute(name) || strchr(name, '/') != nullptr;
}

static bool is_executable_file(const char *path) {
  g_autoptr(GFile) file = g_file_new_for_path(path);
  g_autoptr(GFileInfo) info = g_file_query_info(
      file, G_FILE_ATTRIBUTE_STANDARD_TYPE "," G_FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE,
      G_FILE_QUERY_INFO_NONE, nullptr, nullptr);
  return info != nullptr && g_file_info_get_file_type(info) == G_FILE_TYPE_REGULAR &&
         g_file_info_get_attribute_boolean(info, G_FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE);
}

static gboolean same_file(gconstpointer left_data, gconstpointer right_data) {
  const char *left = left_data;
  const char *right = right_data;
  if (g_str_equal(left, right)) {
    return true;
  }
  g_autoptr(GFile) left_file = g_file_new_for_path(left);
  g_autoptr(GFile) right_file = g_file_new_for_path(right);
  g_autoptr(GFileInfo) left_info = g_file_query_info(
      left_file, G_FILE_ATTRIBUTE_ID_FILE, G_FILE_QUERY_INFO_NONE, nullptr, nullptr);
  g_autoptr(GFileInfo) right_info = g_file_query_info(
      right_file, G_FILE_ATTRIBUTE_ID_FILE, G_FILE_QUERY_INFO_NONE, nullptr, nullptr);
  if (left_info == nullptr || right_info == nullptr) {
    return false;
  }
  const char *left_id =
      g_file_info_get_attribute_string(left_info, G_FILE_ATTRIBUTE_ID_FILE);
  const char *right_id =
      g_file_info_get_attribute_string(right_info, G_FILE_ATTRIBUTE_ID_FILE);
  return left_id != nullptr && right_id != nullptr && g_str_equal(left_id, right_id);
}

static char *self_executable(void) {
#if defined(__APPLE__)
  uint32_t size = 0;
  (void)_NSGetExecutablePath(nullptr, &size);
  char *path = g_malloc(size);
  if (_NSGetExecutablePath(path, &size) == 0) {
    return path;
  }
  g_free(path);
  return nullptr;
#elif defined(__linux__)
  return g_file_read_link("/proc/self/exe", nullptr);
#elif defined(__FreeBSD__) || defined(__DragonFly__)
  return g_file_read_link("/proc/curproc/file", nullptr);
#elif defined(__NetBSD__)
  return g_file_read_link("/proc/curproc/exe", nullptr);
#else
  return nullptr;
#endif
}

static void append_search_path(GPtrArray *paths, const char *value) {
  if (value == nullptr || *value == '\0') {
    return;
  }
  g_auto(GStrv) parts = g_strsplit(value, G_SEARCHPATH_SEPARATOR_S, -1);
  for (size_t index = 0; parts[index] != nullptr; index++) {
    g_ptr_array_add(paths, g_strdup(parts[index]));
  }
}

static bool candidate_is_skipped(const char *candidate, GPtrArray *skip_paths) {
  return g_ptr_array_find_with_equal_func(skip_paths, candidate, same_file, nullptr);
}

static char *find_executable(const TtrRunner *runner) {
  g_autoptr(GPtrArray) skip_paths = g_ptr_array_new_with_free_func(g_free);
  for (size_t index = 0; runner->skip_env[index] != nullptr; index++) {
    append_search_path(skip_paths, g_getenv(runner->skip_env[index]));
  }
  char *self = self_executable();
  if (self != nullptr) {
    g_ptr_array_add(skip_paths, self);
  }

  char *const fallback_programs[] = {runner->name, nullptr};
  char *const *programs =
      runner->programs[0] != nullptr ? runner->programs : fallback_programs;
  char *selected = nullptr;
  for (size_t program_index = 0;
       programs[program_index] != nullptr && selected == nullptr; program_index++) {
    const char *raw_name = programs[program_index];
    if (raw_name[0] == '$') {
      raw_name = g_getenv(raw_name + 1);
      if (raw_name == nullptr || *raw_name == '\0') {
        continue;
      }
    }
    g_autofree char *name = ttr_expand_path(raw_name);
    g_autoptr(GPtrArray) candidates = g_ptr_array_new_with_free_func(g_free);
    if (is_path_like(name)) {
      if (is_executable_file(name)) {
        g_ptr_array_add(candidates, g_strdup(name));
      }
    } else {
      const char *path_environment = g_getenv("PATH");
      g_auto(GStrv) directories =
          g_strsplit(path_environment != nullptr ? path_environment : "",
                     G_SEARCHPATH_SEPARATOR_S, -1);
      for (size_t index = 0; directories[index] != nullptr; index++) {
        char *candidate = *directories[index] == '\0'
                              ? g_strdup(name)
                              : g_build_filename(directories[index], name, nullptr);
        if (is_executable_file(candidate)) {
          g_ptr_array_add(candidates, candidate);
        } else {
          g_free(candidate);
        }
      }
      if (candidates->len == 0) {
        char *candidate = g_find_program_in_path(name);
        if (candidate != nullptr) {
          g_ptr_array_add(candidates, candidate);
        }
      }
    }
    for (guint index = 0; index < candidates->len; index++) {
      const char *candidate = g_ptr_array_index(candidates, index);
      if (!candidate_is_skipped(candidate, skip_paths)) {
        selected = g_strdup(candidate);
        break;
      }
    }
  }
  return selected;
}

static char *find_javascript_runtime(const TtrRuntimeConfig *config,
                                     const char *program_name, GError **error) {
  char *runtime = nullptr;
  for (size_t index = 0;
       config->javascript_runtimes[index] != nullptr && runtime == nullptr; index++) {
    runtime = g_find_program_in_path(config->javascript_runtimes[index]);
  }
  for (size_t index = 0;
       config->javascript_runtime_paths[index] != nullptr && runtime == nullptr;
       index++) {
    if (is_executable_file(config->javascript_runtime_paths[index])) {
      runtime = g_strdup(config->javascript_runtime_paths[index]);
    }
  }
  const char *home = ttr_home_directory();
  for (size_t index = 0;
       home != nullptr && config->javascript_runtime_home_paths[index] != nullptr &&
       runtime == nullptr;
       index++) {
    char *path =
        g_build_filename(home, config->javascript_runtime_home_paths[index], nullptr);
    if (is_executable_file(path)) {
      runtime = path;
    } else {
      g_free(path);
    }
  }
  if (runtime == nullptr) {
    g_autofree char *joined = g_strjoinv(", ", config->javascript_runtimes);
    g_set_error(error, runner_error_quark(), 1,
                "%s requires one of %s, but none were found on PATH or in host "
                "system locations",
                program_name, joined);
  }
  return runtime;
}

static bool configured_interpreter(const TtrRuntimeConfig *runtime,
                                   const char *interpreter) {
  return ttr_strv_contains(runtime->javascript_shebang_interpreters, interpreter);
}

static bool is_javascript_env_shebang(const TtrRuntimeConfig *runtime,
                                      const char *executable) {
  g_autoptr(GFile) file = g_file_new_for_path(executable);
  g_autoptr(GFileInputStream) stream = g_file_read(file, nullptr, nullptr);
  if (stream == nullptr) {
    return false;
  }
  char header[65] = {};
  const gssize count = g_input_stream_read(G_INPUT_STREAM(stream), header,
                                           sizeof header - 1, nullptr, nullptr);
  if (count <= 0) {
    return false;
  }
  char *newline = strchr(header, '\n');
  if (newline != nullptr) {
    *newline = '\0';
  }
  if (!g_str_has_prefix(header, "#!")) {
    return false;
  }
  int argument_count = 0;
  g_auto(GStrv) arguments = nullptr;
  g_autoptr(GError) error = nullptr;
  const bool parsed =
      g_shell_parse_argv(header + 2, &argument_count, &arguments, &error);
  const bool matched = parsed && argument_count >= 2 &&
                       g_str_equal(arguments[0], "/usr/bin/env") &&
                       configured_interpreter(runtime, arguments[1]);
  return matched;
}

static bool resolve_javascript_shebang(const TtrRuntimeConfig *runtime,
                                       const char *program_name, char **executable,
                                       char ***arguments, GError **error) {
  if (!is_javascript_env_shebang(runtime, *executable)) {
    return true;
  }
  char *javascript_runtime = find_javascript_runtime(runtime, program_name, error);
  if (javascript_runtime == nullptr) {
    return false;
  }
  char *script = *executable;
  char *script_arguments[] = {script, nullptr};
  char **resolved_arguments = ttr_strv_concat(script_arguments, *arguments);
  g_strfreev(*arguments);
  *arguments = resolved_arguments;
  *executable = javascript_runtime;
  g_free(script);
  return true;
}

static void configure_child_environment(GSubprocessLauncher *launcher,
                                        const TtrRunner *runner) {
  for (size_t index = 0; runner->env_unset[index] != nullptr; index++) {
    g_subprocess_launcher_unsetenv(launcher, runner->env_unset[index]);
  }
  GHashTableIter iterator;
  gpointer name = nullptr;
  gpointer value = nullptr;
  g_hash_table_iter_init(&iterator, runner->env);
  while (g_hash_table_iter_next(&iterator, &name, &value)) {
    g_subprocess_launcher_setenv(launcher, name, value, true);
  }
}

static int spawn_and_wait(const TtrRunner *runner, const char *executable,
                          char *const *arguments, GError **error) {
  g_autoptr(GStrvBuilder) command = g_strv_builder_new();
  g_strv_builder_add(command, executable);
  ttr_strv_builder_addv(command, arguments);
  g_auto(GStrv) command_line = g_strv_builder_end(command);

  g_autoptr(GSubprocessLauncher) launcher =
      g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDIN_INHERIT);
  if (g_hash_table_size(runner->env) > 0 || runner->env_unset[0] != nullptr) {
    configure_child_environment(launcher, runner);
  }
  g_autoptr(GSubprocess) process =
      g_subprocess_launcher_spawnv(launcher, (const char *const *)command_line, error);
  if (process == nullptr) {
    return 1;
  }
  if (!g_subprocess_wait(process, nullptr, error)) {
    return 1;
  }
  if (g_subprocess_get_if_exited(process)) {
    return g_subprocess_get_exit_status(process);
  }
  if (g_subprocess_get_if_signaled(process)) {
    return 128 + g_subprocess_get_term_sig(process);
  }
  return 1;
}

int ttr_runner_run(const TtrRunner *runner, const TtrIntegration *integration,
                   const TtrRuntimeConfig *runtime, char *const *extra_args,
                   GError **error) {
  g_return_val_if_fail(runtime != nullptr, 1);
  g_autofree char *executable = find_executable(runner);
  if (executable == nullptr) {
    g_set_error(error, runner_error_quark(), 1, "%s executable not found",
                runner->name);
    return 1;
  }

  g_auto(TtrPreparedArgs) prepared = {};
  if (!ttr_prepare_integration(integration, runtime, extra_args, &prepared, error)) {
    return 1;
  }
  g_auto(GStrv) arguments = ttr_strv_concat(runner->default_args, prepared.argv);
  if (!resolve_javascript_shebang(runtime, runner->name, &executable, &arguments,
                                  error)) {
    return 1;
  }
  return spawn_and_wait(runner, executable, arguments, error);
}
