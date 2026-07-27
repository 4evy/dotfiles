#include "toml-schema.h"

#include <stdckdint.h>
#include <stdint.h>
#include <string.h>

static GQuark toml_schema_error_quark(void) {
  return g_quark_from_static_string("terminal-theme-run-toml-schema-error");
}

static void *field_address(void *target, gsize offset) {
  return G_STRUCT_MEMBER_P(target, offset);
}

/*
 * The schema stores member offsets independently of their aggregate types, so
 * use memcpy to avoid forming a potentially misaligned lvalue at a byte
 * offset. Keep the temporary's type identical to the member's declared type:
 * ISO C only guarantees common representations for specific pointer
 * categories, not for every object pointer and pointer-to-pointer type.
 */
static char *string_field_value(void *target, gsize offset) {
  char *value = nullptr;
  memcpy(&value, field_address(target, offset), sizeof value);
  return value;
}

static void set_string_field_value(void *target, gsize offset, char *value) {
  memcpy(field_address(target, offset), &value, sizeof value);
}

static char **string_array_field_value(void *target, gsize offset) {
  char **value = nullptr;
  memcpy(&value, field_address(target, offset), sizeof value);
  return value;
}

static void set_string_array_field_value(void *target, gsize offset, char **value) {
  memcpy(field_address(target, offset), &value, sizeof value);
}

static GHashTable *hash_table_field_value(void *target, gsize offset) {
  GHashTable *value = nullptr;
  memcpy(&value, field_address(target, offset), sizeof value);
  return value;
}

static void set_hash_table_field_value(void *target, gsize offset, GHashTable *value) {
  memcpy(field_address(target, offset), &value, sizeof value);
}

static void set_int64_field_value(void *target, gsize offset, gint64 value) {
  memcpy(field_address(target, offset), &value, sizeof value);
}

static GHashTable *new_string_map(void) {
  return g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
}

typedef void (*FieldInitializer)(void *target, gsize offset);
typedef bool (*FieldLoader)(toml_datum_t value, void *target, gsize offset,
                            const char *key, GError **error);
typedef void (*FieldDestructor)(void *target, gsize offset);

typedef struct {
  FieldInitializer initialize;
  FieldLoader load;
  FieldDestructor clear;
} FieldOperations;

static void initialize_string(void *target, gsize offset) {
  set_string_field_value(target, offset, g_strdup(""));
}

static void initialize_string_array(void *target, gsize offset) {
  set_string_array_field_value(target, offset, g_new0(char *, 1));
}

static void initialize_string_map(void *target, gsize offset) {
  set_hash_table_field_value(target, offset, new_string_map());
}

static void initialize_int64(void *target, gsize offset) {
  set_int64_field_value(target, offset, 0);
}

static bool load_string(toml_datum_t value, void *target, gsize offset, const char *key,
                        GError **error) {
  if (value.type != TOML_STRING) {
    g_set_error(error, toml_schema_error_quark(), 1, "field %s must be a string", key);
    return false;
  }
  set_string_field_value(target, offset, g_strdup(value.u.s));
  return true;
}

static bool load_string_array(toml_datum_t value, void *target, gsize offset,
                              const char *key, GError **error) {
  if (value.type != TOML_ARRAY) {
    g_set_error(error, toml_schema_error_quark(), 1, "field %s must be an array", key);
    return false;
  }
  gsize allocation_count = 0;
  if (value.u.arr.size < 0 ||
      ckd_add(&allocation_count, (gsize)value.u.arr.size, (gsize)1)) {
    g_set_error(error, toml_schema_error_quark(), 1,
                "field %s has an invalid array size", key);
    return false;
  }
  g_auto(GStrv) output = g_new0(char *, allocation_count);
  for (int32_t index = 0; index < value.u.arr.size; index++) {
    const toml_datum_t element = value.u.arr.elem[index];
    if (element.type != TOML_STRING) {
      g_set_error(error, toml_schema_error_quark(), 1,
                  "field %s must contain only strings", key);
      return false;
    }
    output[index] = g_strdup(element.u.s);
  }
  set_string_array_field_value(target, offset, g_steal_pointer(&output));
  return true;
}

static bool load_string_map(toml_datum_t value, void *target, gsize offset,
                            const char *key, GError **error) {
  if (value.type != TOML_TABLE) {
    g_set_error(error, toml_schema_error_quark(), 1, "field %s must be a table", key);
    return false;
  }
  g_autoptr(GHashTable) output = new_string_map();
  for (int32_t index = 0; index < value.u.tab.size; index++) {
    const toml_datum_t element = value.u.tab.value[index];
    if (element.type != TOML_STRING) {
      g_set_error(error, toml_schema_error_quark(), 1,
                  "field %s values must all be strings", key);
      return false;
    }
    g_hash_table_insert(output, g_strdup(value.u.tab.key[index]),
                        g_strdup(element.u.s));
  }
  set_hash_table_field_value(target, offset, g_steal_pointer(&output));
  return true;
}

static bool load_environment(toml_datum_t value, void *target, gsize offset,
                             const char *key, GError **error) {
  if (value.type == TOML_TABLE) {
    return load_string_map(value, target, offset, key, error);
  }
  if (value.type != TOML_ARRAY) {
    g_set_error(error, toml_schema_error_quark(), 1,
                "field %s must be a table or an array of assignments", key);
    return false;
  }

  g_autoptr(GHashTable) output = new_string_map();
  for (int32_t index = 0; index < value.u.arr.size; index++) {
    const toml_datum_t element = value.u.arr.elem[index];
    if (element.type != TOML_STRING) {
      g_set_error(error, toml_schema_error_quark(), 1,
                  "field %s assignments must all be strings", key);
      return false;
    }
    g_auto(GStrv) assignment = g_strsplit(element.u.s, "=", 2);
    if (*assignment[0] == '\0' || assignment[1] == nullptr) {
      g_set_error(error, toml_schema_error_quark(), 1,
                  "field %s contains an invalid environment assignment", key);
      return false;
    }
    g_hash_table_replace(output, g_strdup(assignment[0]), g_strdup(assignment[1]));
  }
  set_hash_table_field_value(target, offset, g_steal_pointer(&output));
  return true;
}

static bool load_int64(toml_datum_t value, void *target, gsize offset, const char *key,
                       GError **error) {
  if (value.type != TOML_INT64) {
    g_set_error(error, toml_schema_error_quark(), 1, "field %s must be an integer",
                key);
    return false;
  }
  set_int64_field_value(target, offset, value.u.int64);
  return true;
}

static void clear_string(void *target, gsize offset) {
  g_free(string_field_value(target, offset));
  set_string_field_value(target, offset, nullptr);
}

static void clear_string_array(void *target, gsize offset) {
  g_strfreev(string_array_field_value(target, offset));
  set_string_array_field_value(target, offset, nullptr);
}

static void clear_hash_table(void *target, gsize offset) {
  GHashTable *value = hash_table_field_value(target, offset);
  if (value != nullptr) {
    g_hash_table_unref(value);
  }
  set_hash_table_field_value(target, offset, nullptr);
}

static void clear_int64(void *target, gsize offset) {
  set_int64_field_value(target, offset, 0);
}

static const FieldOperations field_operations[] = {
#define TTR_TOML_FIELD_TYPE(enum_suffix, initializer, loader, destructor)              \
  [TTR_TOML_FIELD_##enum_suffix] = {                                                   \
      .initialize = initialize_##initializer,                                          \
      .load = load_##loader,                                                           \
      .clear = clear_##destructor,                                                     \
  },
#include "toml-field-types.def"
#undef TTR_TOML_FIELD_TYPE
};

static_assert(G_N_ELEMENTS(field_operations) == TTR_TOML_FIELD_COUNT);

static const FieldOperations *operations_for(TtrTomlFieldType type) {
  return type < TTR_TOML_FIELD_COUNT ? &field_operations[type] : nullptr;
}

static bool load_field(toml_datum_t table, void *target, const TtrTomlField *field,
                       GError **error) {
  const FieldOperations *operations = operations_for(field->type);
  if (operations == nullptr) {
    g_set_error(error, toml_schema_error_quark(), 1,
                "field %s has an unsupported schema type", field->key);
    return false;
  }

  const toml_datum_t value = toml_get(table, field->key);
  if (value.type != TOML_UNKNOWN) {
    return operations->load(value, target, field->offset, field->key, error);
  }
  if (field->required) {
    g_set_error(error, toml_schema_error_quark(), 1, "required field %s is missing",
                field->key);
    return false;
  }
  operations->initialize(target, field->offset);
  return true;
}

bool ttr_toml_load_fields(toml_datum_t table, void *target, const TtrTomlField *fields,
                          size_t field_count, GError **error) {
  g_return_val_if_fail(target != nullptr, false);
  g_return_val_if_fail(fields != nullptr || field_count == 0, false);
  g_return_val_if_fail(table.type == TOML_TABLE, false);
  for (int32_t key_index = 0; key_index < table.u.tab.size; key_index++) {
    bool known = false;
    for (size_t field_index = 0; field_index < field_count; field_index++) {
      if (g_str_equal(table.u.tab.key[key_index], fields[field_index].key)) {
        known = true;
        break;
      }
    }
    if (!known) {
      g_set_error(error, toml_schema_error_quark(), 1, "unknown field %s",
                  table.u.tab.key[key_index]);
      return false;
    }
  }
  for (size_t index = 0; index < field_count; index++) {
    if (!load_field(table, target, &fields[index], error)) {
      ttr_toml_clear_fields(target, fields, index);
      return false;
    }
  }
  return true;
}

void ttr_toml_clear_fields(void *target, const TtrTomlField *fields,
                           size_t field_count) {
  if (target == nullptr) {
    return;
  }
  for (size_t index = 0; index < field_count; index++) {
    const FieldOperations *operations = operations_for(fields[index].type);
    if (operations != nullptr) {
      operations->clear(target, fields[index].offset);
    }
  }
}
