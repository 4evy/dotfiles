#ifndef TTR_CONTEXT_H
#define TTR_CONTEXT_H

#include <glib.h>

/*
 * Build a nested TOML assignment from a directory-oriented runtime context.
 *
 * Policy stays in the integration manifest: it supplies the program's path
 * options, optional commands which discover related directories, and the TOML
 * shape to render. The implementation only provides the reusable mechanics.
 */
[[nodiscard]] char *
ttr_toml_directory_context(const char *table, const char *field, const char *value,
                           char *const *arguments, char *const *path_flags,
                           char *const *path_prefixes, const char *argument_separator,
                           char *const *directory_commands);

#endif
