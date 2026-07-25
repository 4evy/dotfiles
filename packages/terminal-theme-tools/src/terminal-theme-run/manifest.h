#ifndef TTR_MANIFEST_H
#define TTR_MANIFEST_H

#include <glib.h>

typedef enum : unsigned char {
  TTR_INTEGRATION_STRATEGY_INVALID,
#define TTR_INTEGRATION_STRATEGY(enum_suffix, manifest_name, function_stem)            \
  TTR_INTEGRATION_STRATEGY_##enum_suffix,
#include "integration-strategies.def"
#undef TTR_INTEGRATION_STRATEGY
  TTR_INTEGRATION_STRATEGY_COUNT,
} TtrIntegrationStrategy;

#define TTR_FIELD_MEMBER_STRING(member) char *member;
#define TTR_FIELD_MEMBER_STRING_ARRAY(member) char **member;
#define TTR_FIELD_MEMBER_STRING_MAP(member) GHashTable *member;
#define TTR_FIELD_MEMBER_ENVIRONMENT(member) GHashTable *member;
#define TTR_FIELD_MEMBER_INT64(member) gint64 member;
#define TTR_FIELD_MEMBER(member, type) TTR_FIELD_MEMBER_##type(member)

typedef struct {
#define TTR_RUNNER_FIELD(member, type, required) TTR_FIELD_MEMBER(member, type)
#include "runner-fields.def"
#undef TTR_RUNNER_FIELD
} TtrRunner;

typedef struct {
#define TTR_INTEGRATION_FIELD(member, type, required) TTR_FIELD_MEMBER(member, type)
#include "integration-fields.def"
#undef TTR_INTEGRATION_FIELD
  TtrIntegrationStrategy strategy_kind;
} TtrIntegration;

typedef struct {
#define TTR_RUNTIME_FIELD(member, type, required) TTR_FIELD_MEMBER(member, type)
#include "runtime-fields.def"
#undef TTR_RUNTIME_FIELD
} TtrRuntimeConfig;

#undef TTR_FIELD_MEMBER
#undef TTR_FIELD_MEMBER_INT64
#undef TTR_FIELD_MEMBER_ENVIRONMENT
#undef TTR_FIELD_MEMBER_STRING_MAP
#undef TTR_FIELD_MEMBER_STRING_ARRAY
#undef TTR_FIELD_MEMBER_STRING

typedef struct {
  GHashTable *runners;
  GHashTable *integrations;
  TtrRuntimeConfig runtime;
} TtrManifest;

[[nodiscard]] TtrManifest *ttr_manifest_load(GError **error);
void ttr_manifest_free(TtrManifest *manifest);
[[nodiscard]] const TtrRunner *ttr_manifest_find(const TtrManifest *manifest,
                                                 const char *name);
[[nodiscard]] const TtrIntegration *
ttr_manifest_find_integration(const TtrManifest *manifest, const char *name);
[[nodiscard]] const TtrRuntimeConfig *ttr_manifest_runtime(const TtrManifest *manifest);
[[nodiscard]] char **ttr_manifest_program_names(const TtrManifest *manifest);

G_DEFINE_AUTOPTR_CLEANUP_FUNC(TtrManifest, ttr_manifest_free)

#endif
