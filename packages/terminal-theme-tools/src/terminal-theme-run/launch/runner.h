#ifndef TTR_LAUNCH_RUNNER_H
#define TTR_LAUNCH_RUNNER_H

#include "config/manifest.h"

#include <glib.h>

[[nodiscard]] int ttr_runner_run(const TtrRunner *runner,
                                 const TtrIntegration *integration,
                                 const TtrRuntimeConfig *runtime,
                                 char *const *extra_args, GError **error);

#endif
