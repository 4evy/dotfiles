#include "support/filesystem.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gunixinputstream.h>
#include <glib/gstdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static constexpr char home_environment[] = "HOME";
static constexpr char cache_environment[] = "XDG_CACHE_HOME";
static constexpr char temporary_environment[] = "TMPDIR";

const char *ttr_home_directory(void) {
  const char *home = g_getenv(home_environment);
  return home != nullptr && *home != '\0' ? home : g_get_home_dir();
}

char *ttr_expand_path(const char *path) {
  const char *home = ttr_home_directory();
  if (home == nullptr || path == nullptr) {
    return g_strdup(path);
  }
  if (g_str_equal(path, "~")) {
    return g_strdup(home);
  }
  if (g_str_has_prefix(path, "~/")) {
    return g_build_filename(home, path + 2, nullptr);
  }
  return g_strdup(path);
}

static char *environment_directory(const char *name) {
  const char *value = g_getenv(name);
  return value != nullptr && *value != '\0' ? g_strdup(value) : nullptr;
}

#if defined(__APPLE__)
static char *darwin_directory(int name) {
  const size_t required = confstr(name, nullptr, 0);
  if (required == 0) {
    return nullptr;
  }
  char *path = g_try_malloc(required);
  if (path == nullptr || confstr(name, path, required) == 0) {
    g_free(path);
    return nullptr;
  }
  return path;
}
#endif

char *ttr_user_cache_directory(void) {
  char *directory = environment_directory(cache_environment);
#if defined(__APPLE__)
  if (directory == nullptr) {
    directory = darwin_directory(_CS_DARWIN_USER_CACHE_DIR);
  }
#endif
  return directory != nullptr ? directory : g_strdup(g_get_user_cache_dir());
}

char *ttr_user_temporary_directory(void) {
  char *directory = environment_directory(temporary_environment);
#if defined(__APPLE__)
  if (directory == nullptr) {
    directory = darwin_directory(_CS_DARWIN_USER_TEMP_DIR);
  }
#endif
  return directory != nullptr ? directory : g_strdup(g_get_tmp_dir());
}

static TtrFileReadResult file_read_error(const char *path, GError **error) {
  const int saved_errno = errno;
  if (saved_errno == ENOENT || saved_errno == ENOTDIR) {
    return TTR_FILE_READ_NOT_FOUND;
  }
  const GIOErrorEnum code = g_io_error_from_errno(saved_errno);
  g_set_error(error, G_IO_ERROR, (gint)code, "failed to open %s: %s", path,
              g_strerror(saved_errno));
  return TTR_FILE_READ_ERROR;
}

TtrFileReadResult ttr_read_regular_file(const char *path, gsize maximum_bytes,
                                        char **contents, gsize *length,
                                        GError **error) {
  g_return_val_if_fail(path != nullptr, TTR_FILE_READ_ERROR);
  g_return_val_if_fail(contents != nullptr, TTR_FILE_READ_ERROR);
  g_return_val_if_fail(length != nullptr, TTR_FILE_READ_ERROR);
  g_return_val_if_fail(maximum_bytes < G_MAXSIZE - 1, TTR_FILE_READ_ERROR);
  *contents = nullptr;
  *length = 0;

  const int descriptor = g_open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK, 0);
  if (descriptor < 0) {
    return file_read_error(path, error);
  }
  g_autoptr(GInputStream) stream = g_unix_input_stream_new(descriptor, true);

  struct stat status;
  if (fstat(descriptor, &status) != 0) {
    const int saved_errno = errno;
    const GIOErrorEnum code = g_io_error_from_errno(saved_errno);
    g_set_error(error, G_IO_ERROR, (gint)code, "failed to inspect %s: %s", path,
                g_strerror(saved_errno));
    return TTR_FILE_READ_ERROR;
  }
  if (!S_ISREG(status.st_mode)) {
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_NOT_REGULAR_FILE,
                "%s is not a regular file", path);
    return TTR_FILE_READ_ERROR;
  }
  if (status.st_size < 0 || (guint64)status.st_size > (guint64)maximum_bytes) {
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_MESSAGE_TOO_LARGE,
                "%s exceeds the %zu-byte size limit", path, maximum_bytes);
    return TTR_FILE_READ_ERROR;
  }

  const gsize detection_limit = maximum_bytes + 1;
  g_autofree char *buffer = g_try_malloc(detection_limit);
  if (buffer == nullptr) {
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_NO_SPACE,
                "failed to allocate space for %s", path);
    return TTR_FILE_READ_ERROR;
  }

  gsize used = 0;
  if (!g_input_stream_read_all(stream, buffer, detection_limit, &used, nullptr,
                               error)) {
    g_prefix_error(error, "failed to read %s: ", path);
    return TTR_FILE_READ_ERROR;
  }
  if (used > maximum_bytes) {
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_MESSAGE_TOO_LARGE,
                "%s exceeds the %zu-byte size limit", path, maximum_bytes);
    return TTR_FILE_READ_ERROR;
  }

  buffer[used] = '\0';
  *contents = g_steal_pointer(&buffer);
  *length = used;
  return TTR_FILE_READ_OK;
}
