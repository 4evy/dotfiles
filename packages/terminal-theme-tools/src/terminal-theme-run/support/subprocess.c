#include "support/subprocess.h"

#include <gio/gio.h>
#include <string.h>

typedef struct {
  GMainLoop *loop;
  GSubprocess *process;
  GCancellable *cancellable;
  GError *error;
  gsize maximum_bytes;
  bool process_done;
  bool stream_done;
} SubprocessCapture;

static void capture_maybe_finish(SubprocessCapture *capture) {
  if (capture->process_done && capture->stream_done) {
    g_main_loop_quit(capture->loop);
  }
}

static void capture_fail(SubprocessCapture *capture, GError *error) {
  if (capture->error == nullptr) {
    capture->error = error;
  } else {
    g_error_free(error);
  }
  if (!capture->process_done) {
    g_subprocess_force_exit(capture->process);
  }
  g_cancellable_cancel(capture->cancellable);
}

static void capture_splice_ready(GObject *source, GAsyncResult *result,
                                 gpointer user_data) {
  SubprocessCapture *capture = user_data;
  g_autoptr(GError) error = nullptr;
  if (g_output_stream_splice_finish(G_OUTPUT_STREAM(source), result, &error) < 0) {
    if (!(capture->error != nullptr &&
          g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED))) {
      if (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_NO_SPACE)) {
        g_clear_error(&error);
        error = g_error_new(G_IO_ERROR, G_IO_ERROR_MESSAGE_TOO_LARGE,
                            "subprocess output exceeds the %zu-byte size limit",
                            capture->maximum_bytes);
      }
      capture_fail(capture, g_steal_pointer(&error));
    }
  }
  capture->stream_done = true;
  capture_maybe_finish(capture);
}

static void capture_wait_ready(GObject *source, GAsyncResult *result,
                               gpointer user_data) {
  SubprocessCapture *capture = user_data;
  g_autoptr(GError) error = nullptr;
  if (!g_subprocess_wait_finish(G_SUBPROCESS(source), result, &error)) {
    capture_fail(capture, g_steal_pointer(&error));
  }
  capture->process_done = true;
  capture_maybe_finish(capture);
}

static gboolean capture_timed_out(gpointer user_data) {
  SubprocessCapture *capture = user_data;
  capture_fail(capture, g_error_new_literal(G_IO_ERROR, G_IO_ERROR_TIMED_OUT,
                                            "subprocess timed out"));
  return G_SOURCE_REMOVE;
}

bool ttr_subprocess_capture_stdout(const char *const *arguments, guint timeout_ms,
                                   gsize maximum_bytes, char **output, bool *successful,
                                   GError **error) {
  g_return_val_if_fail(arguments != nullptr && arguments[0] != nullptr, false);
  g_return_val_if_fail(timeout_ms > 0, false);
  g_return_val_if_fail(maximum_bytes > 0 && maximum_bytes < G_MAXUINT &&
                           maximum_bytes <= G_MAXSSIZE,
                       false);
  g_return_val_if_fail(output != nullptr, false);
  g_return_val_if_fail(successful != nullptr, false);
  *output = nullptr;
  *successful = false;

  g_autoptr(GSubprocess) process = g_subprocess_newv(
      arguments, G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_SILENCE,
      error);
  if (process == nullptr) {
    return false;
  }

  g_autoptr(GMainContext) context = g_main_context_new();
  g_autoptr(GMainLoop) loop = g_main_loop_new(context, false);
  g_autoptr(GCancellable) cancellable = g_cancellable_new();
  g_autofree unsigned char *buffer = g_try_malloc(maximum_bytes + 1);
  if (buffer == nullptr) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_NO_SPACE,
                        "failed to allocate subprocess output buffer");
    return false;
  }
  g_autoptr(GOutputStream) output_stream =
      g_memory_output_stream_new(buffer, maximum_bytes + 1, nullptr, nullptr);
  SubprocessCapture capture = {
      .loop = loop,
      .process = process,
      .cancellable = cancellable,
      .maximum_bytes = maximum_bytes,
  };
  g_autoptr(GSource) timeout = g_timeout_source_new(timeout_ms);
  g_source_set_callback(timeout, capture_timed_out, &capture, nullptr);

  g_main_context_push_thread_default(context);
  g_output_stream_splice_async(output_stream, g_subprocess_get_stdout_pipe(process),
                               G_OUTPUT_STREAM_SPLICE_CLOSE_SOURCE, G_PRIORITY_DEFAULT,
                               cancellable, capture_splice_ready, &capture);
  g_subprocess_wait_async(process, nullptr, capture_wait_ready, &capture);
  (void)g_source_attach(timeout, context);
  g_main_loop_run(loop);
  g_source_destroy(timeout);
  g_main_context_pop_thread_default(context);

  if (capture.error != nullptr) {
    g_propagate_error(error, capture.error);
    return false;
  }
  const gsize length =
      g_memory_output_stream_get_data_size(G_MEMORY_OUTPUT_STREAM(output_stream));
  if (length > maximum_bytes) {
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_MESSAGE_TOO_LARGE,
                "subprocess output exceeds the %zu-byte size limit", maximum_bytes);
    return false;
  }
  if (memchr(buffer, '\0', length) != nullptr ||
      !g_utf8_validate((const char *)buffer, (gssize)length, nullptr)) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA,
                        "subprocess output is not valid UTF-8 text");
    return false;
  }

  *successful = g_subprocess_get_successful(process);
  buffer[length] = '\0';
  *output = (char *)g_steal_pointer(&buffer);
  return true;
}
