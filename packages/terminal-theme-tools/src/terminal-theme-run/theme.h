#ifndef TTR_THEME_H
#define TTR_THEME_H

#include "manifest.h"
#include "terminal.h"

#include <glib.h>

typedef struct {
  char **argv;
  char *temporary_path;
} TtrPreparedArgs;

void ttr_prepared_args_clear(TtrPreparedArgs *prepared);
G_DEFINE_AUTO_CLEANUP_CLEAR_FUNC(TtrPreparedArgs, ttr_prepared_args_clear)

[[nodiscard]] bool ttr_prepare_integration(const TtrIntegration *integration,
                                           const TtrRuntimeConfig *runtime,
                                           char *const *extra_args,
                                           TtrPreparedArgs *prepared, GError **error);

#endif
