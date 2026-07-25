#include "terminal.h"

#include "util.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <stdint.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <vterm.h>

G_DEFINE_AUTOPTR_CLEANUP_FUNC(VTerm, vterm_free)

static constexpr char color_scheme_query[] = "\x1b[?996n";
static constexpr char background_query[] = "\x1b]11;?\a";

static bool parse_color_component(const char *text, double *component) {
  const size_t length = strlen(text);
  if (length == 0 || length > 4) {
    return false;
  }
  char *end = nullptr;
  errno = 0;
  const guint64 value = g_ascii_strtoull(text, &end, 16);
  if (errno != 0 || end == text || *end != '\0') {
    return false;
  }
  const guint64 maximum = (UINT64_C(1) << (length * 4)) - 1;
  *component = (double)value / (double)maximum;
  return true;
}

bool ttr_theme_mode_from_text(const TtrRuntimeConfig *runtime, const char *text,
                              TtrThemeMode *mode) {
  if (runtime == nullptr || text == nullptr || mode == nullptr) {
    return false;
  }
  g_autofree char *normalized = g_ascii_strdown(text, -1);
  g_strstrip(normalized);
  const struct {
    const char *keyword;
    char *const *aliases;
    TtrThemeMode mode;
  } candidates[] = {
      {
          .keyword = "dark",
          .aliases = runtime->theme_dark_aliases,
          .mode = TTR_THEME_DARK,
      },
      {
          .keyword = "light",
          .aliases = runtime->theme_light_aliases,
          .mode = TTR_THEME_LIGHT,
      },
  };
  for (size_t index = 0; index < G_N_ELEMENTS(candidates); index++) {
    if (strstr(normalized, candidates[index].keyword) != nullptr) {
      *mode = candidates[index].mode;
      return true;
    }
  }

  const size_t length = strlen(normalized);
  if (length >= 2 && ((normalized[0] == '\'' && normalized[length - 1] == '\'') ||
                      (normalized[0] == '"' && normalized[length - 1] == '"'))) {
    normalized[length - 1] = '\0';
    memmove(normalized, normalized + 1, length - 1);
  }
  for (size_t index = 0; index < G_N_ELEMENTS(candidates); index++) {
    if (ttr_strv_contains(candidates[index].aliases, normalized)) {
      *mode = candidates[index].mode;
      return true;
    }
  }
  return false;
}

typedef struct {
  GString *osc;
  TtrThemeMode mode;
  bool detected;
} TerminalReport;

static int parse_color_scheme_report(const char *leader, const long arguments[],
                                     int argument_count, const char *intermediate,
                                     char command, void *user) {
  TerminalReport *report = user;
  if (!report->detected && leader != nullptr && g_str_equal(leader, "?") &&
      intermediate == nullptr && command == 'n' && argument_count == 2 &&
      CSI_ARG(arguments[0]) == 997) {
    if (CSI_ARG(arguments[1]) == 1) {
      report->mode = TTR_THEME_DARK;
      report->detected = true;
    } else if (CSI_ARG(arguments[1]) == 2) {
      report->mode = TTR_THEME_LIGHT;
      report->detected = true;
    }
  }
  return 1;
}

static int parse_background_report(int command, VTermStringFragment fragment,
                                   void *user) {
  TerminalReport *report = user;
  if (report->detected || command != 11) {
    return 1;
  }
  if (fragment.initial) {
    g_string_truncate(report->osc, 0);
  }
  g_string_append_len(report->osc, fragment.str, (gssize)fragment.len);
  if (!fragment.final) {
    return 1;
  }

  const char *color = report->osc->str;
  if (g_str_has_prefix(color, "rgb:")) {
    color += strlen("rgb:");
  }
  g_auto(GStrv) components = g_strsplit(color, "/", 4);
  double red = 0.0;
  double green = 0.0;
  double blue = 0.0;
  if (components[0] == nullptr || components[1] == nullptr ||
      components[2] == nullptr || components[3] != nullptr ||
      !parse_color_component(components[0], &red) ||
      !parse_color_component(components[1], &green) ||
      !parse_color_component(components[2], &blue)) {
    return 1;
  }

  const double luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
  report->mode = luminance > 0.5 ? TTR_THEME_LIGHT : TTR_THEME_DARK;
  report->detected = true;
  return 1;
}

bool ttr_parse_terminal_report(const void *buffer, size_t length, TtrThemeMode *mode) {
  if (buffer == nullptr || mode == nullptr) {
    return false;
  }

  static const VTermParserCallbacks callbacks = {
      .csi = parse_color_scheme_report,
      .osc = parse_background_report,
  };
  g_autoptr(GString) osc = g_string_sized_new(length);
  TerminalReport report = {
      .osc = osc,
  };
  g_autoptr(VTerm) parser = vterm_new(1, 1);
  if (parser == nullptr) {
    return false;
  }
  vterm_parser_set_callbacks(parser, &callbacks, &report);
  (void)vterm_input_write(parser, buffer, length);
  if (report.detected) {
    *mode = report.mode;
  }
  return report.detected;
}

static const char *terminal_theme_query(const TtrRuntimeConfig *runtime) {
  const char *term_program = g_getenv(runtime->theme_terminal_program_environment);
  g_autofree char *normalized =
      term_program != nullptr ? g_ascii_strdown(term_program, -1) : nullptr;
  const char *protocol =
      normalized != nullptr
          ? g_hash_table_lookup(runtime->theme_terminal_queries, normalized)
          : nullptr;
  if (protocol == nullptr) {
    protocol = g_hash_table_lookup(runtime->theme_terminal_queries, "*");
  }
  return g_str_equal(protocol, "color-scheme") ? color_scheme_query : background_query;
}

static bool make_raw(int descriptor, struct termios *saved) {
  if (tcgetattr(descriptor, saved) != 0) {
    return false;
  }
  struct termios raw = *saved;
  raw.c_iflag &= (tcflag_t) ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
  raw.c_oflag &= (tcflag_t)~OPOST;
  raw.c_cflag |= CS8;
  raw.c_lflag &= (tcflag_t) ~(ECHO | ICANON | IEXTEN | ISIG);
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;
  return tcsetattr(descriptor, TCSAFLUSH, &raw) == 0;
}

static bool write_all(int descriptor, const void *buffer, size_t length) {
  const unsigned char *cursor = buffer;
  while (length > 0) {
    const ssize_t count = write(descriptor, cursor, length);
    if (count > 0) {
      cursor += (size_t)count;
      length -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) {
      continue;
    }
    return false;
  }
  return true;
}

static bool detect_terminal_theme(const TtrRuntimeConfig *runtime, TtrThemeMode *mode) {
  g_autofd int descriptor = g_open("/dev/tty", O_RDWR | O_CLOEXEC, 0);
  if (descriptor < 0) {
    return false;
  }
  struct termios saved;
  if (!make_raw(descriptor, &saved)) {
    return false;
  }

  const char *query = terminal_theme_query(runtime);
  const bool wrote_query = write_all(descriptor, query, strlen(query));
  unsigned char buffer[128];
  size_t length = 0;
  bool detected = false;
  const gint64 deadline =
      g_get_monotonic_time() + runtime->theme_probe_timeout_ms * INT64_C(1000);
  while (wrote_query && g_get_monotonic_time() < deadline && length < sizeof buffer) {
    gint64 remaining_us = deadline - g_get_monotonic_time();
    int remaining_ms = (int)((remaining_us + 999) / 1000);
    if (remaining_ms < 1) {
      remaining_ms = 1;
    }
    GPollFD event = {.fd = descriptor, .events = G_IO_IN};
    const int count = g_poll(&event, 1, remaining_ms);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      break;
    }
    const ssize_t read_count =
        read(descriptor, buffer + length, sizeof buffer - length);
    if (read_count <= 0) {
      break;
    }
    length += (size_t)read_count;
    if (ttr_parse_terminal_report(buffer, length, mode)) {
      detected = true;
      break;
    }
  }
  if (!detected && length > 0) {
    detected = ttr_parse_terminal_report(buffer, length, mode);
  }
  (void)tcsetattr(descriptor, TCSAFLUSH, &saved);
  return detected;
}

static bool mode_from_configured_command(const TtrRuntimeConfig *runtime,
                                         const char *command, TtrThemeMode *mode) {
  int argument_count = 0;
  g_auto(GStrv) arguments = nullptr;
  g_autoptr(GError) error = nullptr;
  if (!g_shell_parse_argv(command, &argument_count, &arguments, &error) ||
      argument_count == 0) {
    return false;
  }
  g_autoptr(GSubprocess) process = g_subprocess_newv(
      (const char *const *)arguments,
      G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_SILENCE, &error);
  if (process == nullptr) {
    return false;
  }
  g_autofree char *output = nullptr;
  const bool communicated = g_subprocess_communicate_utf8(process, nullptr, nullptr,
                                                          &output, nullptr, &error);
  const bool succeeded = communicated && g_subprocess_get_successful(process) &&
                         ttr_theme_mode_from_text(runtime, output, mode);
  return succeeded;
}

TtrThemeMode ttr_detect_theme(const TtrRuntimeConfig *runtime) {
  g_return_val_if_fail(runtime != nullptr, TTR_THEME_DARK);
  TtrThemeMode mode;
  for (size_t index = 0; runtime->theme_environment[index] != nullptr; index++) {
    if (ttr_theme_mode_from_text(runtime, g_getenv(runtime->theme_environment[index]),
                                 &mode)) {
      return mode;
    }
  }
  if (detect_terminal_theme(runtime, &mode)) {
    return mode;
  }

#if defined(__APPLE__)
  char *const *commands = runtime->theme_macos_commands;
  const char *fallback = runtime->theme_macos_fallback;
#elif defined(__linux__) || defined(__FreeBSD__) || defined(__DragonFly__) ||          \
    defined(__NetBSD__) || defined(__OpenBSD__)
  char *const *commands = runtime->theme_unix_commands;
  const char *fallback = runtime->theme_unix_fallback;
#else
  char *const *commands = nullptr;
  const char *fallback = runtime->theme_unix_fallback;
#endif
  for (size_t index = 0; commands != nullptr && commands[index] != nullptr; index++) {
    if (mode_from_configured_command(runtime, commands[index], &mode)) {
      return mode;
    }
  }
  return g_str_equal(fallback, "light") ? TTR_THEME_LIGHT : TTR_THEME_DARK;
}
