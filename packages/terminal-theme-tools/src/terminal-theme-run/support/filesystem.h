#ifndef TTR_SUPPORT_FILESYSTEM_H
#define TTR_SUPPORT_FILESYSTEM_H

#include <glib.h>

static constexpr gsize ttr_max_input_file_bytes = (gsize)16 * 1024 * 1024;

typedef enum : unsigned char {
  TTR_FILE_READ_OK,
  TTR_FILE_READ_NOT_FOUND,
  TTR_FILE_READ_ERROR,
} TtrFileReadResult;

[[nodiscard("the returned path must be freed")]]
char *ttr_expand_path(const char *path);
[[nodiscard]] const char *ttr_home_directory(void);
[[nodiscard("the returned path must be freed")]]
char *ttr_user_cache_directory(void);
[[nodiscard("the returned path must be freed")]]
char *ttr_user_temporary_directory(void);

[[nodiscard("the caller must check whether the file was read")]]
TtrFileReadResult ttr_read_regular_file(const char *path, gsize maximum_bytes,
                                        char **contents, gsize *length, GError **error);

#endif
