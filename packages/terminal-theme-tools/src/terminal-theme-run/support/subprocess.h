#ifndef TTR_SUPPORT_SUBPROCESS_H
#define TTR_SUPPORT_SUBPROCESS_H

#include <glib.h>

[[nodiscard("the caller must check whether the subprocess completed")]]
bool ttr_subprocess_capture_stdout(const char *const *arguments, guint timeout_ms,
                                   gsize maximum_bytes, char **output, bool *successful,
                                   GError **error);

#endif
