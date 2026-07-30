#include "theme/terminal.h"
#include "config.h"

#include "support/strings.h"
#include "support/subprocess.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <gio/gunixoutputstream.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <stdckdint.h>
#include <stdint.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <vterm.h>

G_DEFINE_AUTOPTR_CLEANUP_FUNC(VTerm, vterm_free)

static constexpr char terminal_environment[] = "TERM";
static constexpr char terminal_device[] = "/dev/tty";
static constexpr size_t maximum_terminal_report_bytes = 128;
static constexpr size_t maximum_color_component_digits = 4;
static constexpr gint64 microseconds_per_millisecond = 1000;
static constexpr int minimum_poll_timeout_ms = 1;
static constexpr int color_scheme_report_code = 997;
static constexpr int color_scheme_dark_value = 1;
static constexpr int color_scheme_light_value = 2;
static constexpr int background_color_command = 11;
static constexpr double light_luminance_threshold = 0.5;
static constexpr double red_luminance_weight = 0.299;
static constexpr double green_luminance_weight = 0.587;
static constexpr double blue_luminance_weight = 0.114;

static const char *const terminal_queries[TTR_TERMINAL_PROTOCOL_COUNT] = {
    [TTR_TERMINAL_PROTOCOL_BACKGROUND] = "\x1b]11;?\a",
    [TTR_TERMINAL_PROTOCOL_COLOR_SCHEME] = "\x1b[?996n",
};

static bool parse_color_component(const char *text, double *component) {
  const size_t length = strlen(text);
  if (length == 0 || length > maximum_color_component_digits) {
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
          .keyword = ttr_theme_mode_name(TTR_THEME_DARK),
          .aliases = runtime->theme_dark_aliases,
          .mode = TTR_THEME_DARK,
      },
      {
          .keyword = ttr_theme_mode_name(TTR_THEME_LIGHT),
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

  g_autofree char *unquoted = g_shell_unquote(normalized, nullptr);
  if (unquoted == nullptr) {
    return false;
  }
  for (size_t index = 0; index < G_N_ELEMENTS(candidates); index++) {
    if (ttr_strv_contains(candidates[index].aliases, unquoted)) {
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
      CSI_ARG(arguments[0]) == color_scheme_report_code) {
    if (CSI_ARG(arguments[1]) == color_scheme_dark_value) {
      report->mode = TTR_THEME_DARK;
      report->detected = true;
    } else if (CSI_ARG(arguments[1]) == color_scheme_light_value) {
      report->mode = TTR_THEME_LIGHT;
      report->detected = true;
    }
  }
  return 1;
}

static int parse_background_report(int command, VTermStringFragment fragment,
                                   void *user) {
  TerminalReport *report = user;
  if (report->detected || command != background_color_command) {
    return 1;
  }
  if (fragment.initial) {
    g_string_truncate(report->osc, 0);
  }
  g_string_append_len(report->osc, fragment.str, (gssize)fragment.len);
  if (!fragment.final) {
    return 1;
  }
  if (memchr(report->osc->str, '\0', report->osc->len) != nullptr) {
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

  const double luminance = red_luminance_weight * red + green_luminance_weight * green +
                           blue_luminance_weight * blue;
  report->mode =
      luminance > light_luminance_threshold ? TTR_THEME_LIGHT : TTR_THEME_DARK;
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

static TtrTerminalProtocol configured_terminal_protocol(const TtrRuntimeConfig *runtime,
                                                        const char *identifier) {
  if (identifier == nullptr || *identifier == '\0') {
    return TTR_TERMINAL_PROTOCOL_INVALID;
  }
  g_autofree char *normalized = g_ascii_strdown(identifier, -1);
  const char *name = g_hash_table_lookup(runtime->theme_terminal_queries, normalized);
  TtrTerminalProtocol protocol = TTR_TERMINAL_PROTOCOL_INVALID;
  (void)ttr_terminal_protocol_from_name(name, &protocol);
  return protocol;
}

const char *ttr_terminal_theme_query(const TtrRuntimeConfig *runtime) {
  g_return_val_if_fail(runtime != nullptr,
                       terminal_queries[TTR_TERMINAL_PROTOCOL_BACKGROUND]);
  const char *identifiers[] = {
      g_getenv(runtime->theme_terminal_program_environment),
      g_getenv(terminal_environment),
  };
  TtrTerminalProtocol protocol = TTR_TERMINAL_PROTOCOL_INVALID;
  for (size_t index = 0; index < G_N_ELEMENTS(identifiers); index++) {
    protocol = configured_terminal_protocol(runtime, identifiers[index]);
    if (protocol != TTR_TERMINAL_PROTOCOL_INVALID) {
      break;
    }
  }
  if (protocol == TTR_TERMINAL_PROTOCOL_INVALID) {
    const char *fallback = g_hash_table_lookup(runtime->theme_terminal_queries,
                                               ttr_terminal_protocol_fallback_key);
    (void)ttr_terminal_protocol_from_name(fallback, &protocol);
  }

  g_return_val_if_fail(protocol > TTR_TERMINAL_PROTOCOL_INVALID &&
                           protocol < TTR_TERMINAL_PROTOCOL_COUNT,
                       terminal_queries[TTR_TERMINAL_PROTOCOL_BACKGROUND]);
  return terminal_queries[protocol];
}

static bool make_raw(int descriptor, struct termios *saved) {
  if (tcgetattr(descriptor, saved) != 0) {
    return false;
  }
  struct termios raw = *saved;
#if HAVE_CFMAKERAW
  cfmakeraw(&raw);
#else
  raw.c_iflag &= (tcflag_t) ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
  raw.c_oflag &= (tcflag_t)~OPOST;
  raw.c_cflag |= CS8;
  raw.c_lflag &= (tcflag_t) ~(ECHO | ICANON | IEXTEN | ISIG);
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;
#endif
  return tcsetattr(descriptor, TCSADRAIN, &raw) == 0;
}

static bool detect_terminal_theme(const TtrRuntimeConfig *runtime, TtrThemeMode *mode) {
  g_autofd int descriptor = g_open(terminal_device, O_RDWR | O_CLOEXEC, 0);
  if (descriptor < 0) {
    return false;
  }
  struct termios saved;
  if (!make_raw(descriptor, &saved)) {
    return false;
  }

  const char *query = ttr_terminal_theme_query(runtime);
  g_autoptr(GOutputStream) terminal_output =
      g_unix_output_stream_new(descriptor, false);
  const bool wrote_query = g_output_stream_write_all(
      terminal_output, query, strlen(query), nullptr, nullptr, nullptr);
  unsigned char buffer[maximum_terminal_report_bytes];
  size_t length = 0;
  bool detected = false;
  gint64 timeout_us = 0;
  gint64 deadline = 0;
  if (runtime->theme_probe_timeout_ms <= 0 ||
      ckd_mul(&timeout_us, runtime->theme_probe_timeout_ms,
              microseconds_per_millisecond) ||
      ckd_add(&deadline, g_get_monotonic_time(), timeout_us)) {
    (void)tcsetattr(descriptor, TCSADRAIN, &saved);
    return false;
  }
  while (wrote_query && g_get_monotonic_time() < deadline && length < sizeof buffer) {
    const gint64 remaining_us = deadline - g_get_monotonic_time();
    const gint64 remaining_ms_64 =
        (remaining_us - 1) / microseconds_per_millisecond + 1;
    const int remaining_ms =
        remaining_ms_64 > G_MAXINT ? G_MAXINT : (int)remaining_ms_64;
    GPollFD event = {.fd = descriptor, .events = G_IO_IN};
    const int count = g_poll(&event, 1, MAX(remaining_ms, minimum_poll_timeout_ms));
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      break;
    }
    const ssize_t read_count =
        read(descriptor, buffer + length, sizeof buffer - length);
    if (read_count < 0 && errno == EINTR) {
      continue;
    }
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
  (void)tcsetattr(descriptor, TCSADRAIN, &saved);
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
  g_autofree char *output = nullptr;
  bool successful = false;
  return ttr_subprocess_capture_stdout(
             (const char *const *)arguments, (guint)runtime->helper_timeout_ms,
             (gsize)runtime->helper_output_limit_bytes, &output, &successful, &error) &&
         successful && ttr_theme_mode_from_text(runtime, output, mode);
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

  const struct {
    char *const *commands;
    TtrThemeMode fallback;
  } platform_policy = {
#if defined(__APPLE__)
      .commands = runtime->theme_macos_commands,
      .fallback = runtime->theme_macos_fallback_mode,
#elif defined(__linux__) || defined(__FreeBSD__) || defined(__DragonFly__) ||          \
    defined(__NetBSD__) || defined(__OpenBSD__)
      .commands = runtime->theme_unix_commands,
      .fallback = runtime->theme_unix_fallback_mode,
#else
      .commands = nullptr,
      .fallback = runtime->theme_unix_fallback_mode,
#endif
  };
  for (size_t index = 0; platform_policy.commands != nullptr &&
                         platform_policy.commands[index] != nullptr;
       index++) {
    if (mode_from_configured_command(runtime, platform_policy.commands[index], &mode)) {
      return mode;
    }
  }
  return platform_policy.fallback;
}
