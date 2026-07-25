#ifndef TTR_TRUST_H
#define TTR_TRUST_H

#include <glib.h>

[[nodiscard]] char *ttr_resolve_launch_cwd(char *const *arguments,
                                           char *const *cwd_flags,
                                           char *const *cwd_prefixes);
[[nodiscard]] char *
ttr_toml_worktree_trust_override(const char *table, const char *field,
                                 const char *value, char *const *arguments,
                                 char *const *cwd_flags, char *const *cwd_prefixes);

#endif
