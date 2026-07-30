#ifndef TTR_THEME_CONTEXT_H
#define TTR_THEME_CONTEXT_H

#include <glib.h>

typedef struct {
  const char *table;
  const char *field;
  const char *value;
} TtrTomlContextShape;

typedef struct {
  char *const *flags;
  char *const *prefixes;
  const char *separator;
} TtrDirectoryArgumentPolicy;

typedef struct {
  char *const *commands;
  guint timeout_ms;
  gsize output_limit_bytes;
} TtrDirectoryDiscoveryPolicy;

/*
 * Policy stays in the integration manifest. This value describes the TOML
 * shape, the command-line directory syntax, and bounded discovery helpers;
 * the implementation only supplies reusable mechanics.
 */
typedef struct {
  TtrTomlContextShape toml;
  TtrDirectoryArgumentPolicy arguments;
  TtrDirectoryDiscoveryPolicy discovery;
} TtrDirectoryContextPolicy;

[[nodiscard]] char *ttr_toml_directory_context(const TtrDirectoryContextPolicy *policy,
                                               char *const *arguments);

#endif
