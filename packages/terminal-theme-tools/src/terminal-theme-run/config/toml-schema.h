#ifndef TTR_CONFIG_TOML_SCHEMA_H
#define TTR_CONFIG_TOML_SCHEMA_H

#include <glib.h>
#include <tomlc17.h>

static inline void ttr_toml_result_clear(toml_result_t *result) { toml_free(*result); }
G_DEFINE_AUTO_CLEANUP_CLEAR_FUNC(toml_result_t, ttr_toml_result_clear)

typedef enum : unsigned char {
#define TTR_TOML_FIELD_TYPE(enum_suffix, initializer, loader, destructor)              \
  TTR_TOML_FIELD_##enum_suffix,
#include "definitions/toml-field-types.def"
#undef TTR_TOML_FIELD_TYPE
  TTR_TOML_FIELD_COUNT,
} TtrTomlFieldType;

typedef struct {
  const char *key;
  gsize offset;
  TtrTomlFieldType type;
  bool required;
} TtrTomlField;

[[nodiscard("the caller must check whether every field was loaded")]]
bool ttr_toml_load_fields(toml_datum_t table, void *target, const TtrTomlField *fields,
                          size_t field_count, GError **error);
void ttr_toml_clear_fields(void *target, const TtrTomlField *fields,
                           size_t field_count);

#endif
