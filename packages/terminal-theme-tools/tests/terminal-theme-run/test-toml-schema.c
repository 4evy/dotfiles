#include "toml-schema.h"

#include <glib.h>
#include <string.h>

typedef struct {
  char *name;
  char **tags;
  GHashTable *metadata;
  GHashTable *environment;
  gint64 count;
} TestRecord;

static const TtrTomlField fields[] = {
    {
        .key = "name",
        .offset = G_STRUCT_OFFSET(TestRecord, name),
        .type = TTR_TOML_FIELD_STRING,
    },
    {
        .key = "tags",
        .offset = G_STRUCT_OFFSET(TestRecord, tags),
        .type = TTR_TOML_FIELD_STRING_ARRAY,
    },
    {
        .key = "metadata",
        .offset = G_STRUCT_OFFSET(TestRecord, metadata),
        .type = TTR_TOML_FIELD_STRING_MAP,
    },
    {
        .key = "environment",
        .offset = G_STRUCT_OFFSET(TestRecord, environment),
        .type = TTR_TOML_FIELD_ENVIRONMENT,
    },
    {
        .key = "count",
        .offset = G_STRUCT_OFFSET(TestRecord, count),
        .type = TTR_TOML_FIELD_INT64,
    },
};

static void test_loads_every_field_type(void) {
  static constexpr char input[] = "name = \"modern\"\n"
                                  "tags = [\"c23\", \"declarative\"]\n"
                                  "metadata = { standard = \"ISO C\" }\n"
                                  "environment = [\"COLOR=always\", \"EMPTY=\"]\n"
                                  "count = 23\n";
  g_auto(toml_result_t) parsed = toml_parse(input, (int)(sizeof input - 1));
  g_assert_true(parsed.ok);

  TestRecord record = {};
  g_autoptr(GError) error = nullptr;
  g_assert_true(ttr_toml_load_fields(parsed.toptab, &record, fields,
                                     G_N_ELEMENTS(fields), &error));
  g_assert_no_error(error);
  g_assert_cmpstr(record.name, ==, "modern");
  g_assert_cmpstr(record.tags[0], ==, "c23");
  g_assert_cmpstr(record.tags[1], ==, "declarative");
  g_assert_null(record.tags[2]);
  g_assert_cmpstr(g_hash_table_lookup(record.metadata, "standard"), ==, "ISO C");
  g_assert_cmpstr(g_hash_table_lookup(record.environment, "COLOR"), ==, "always");
  g_assert_cmpstr(g_hash_table_lookup(record.environment, "EMPTY"), ==, "");
  g_assert_cmpint(record.count, ==, 23);

  ttr_toml_clear_fields(&record, fields, G_N_ELEMENTS(fields));
  g_assert_null(record.name);
  g_assert_null(record.tags);
  g_assert_null(record.metadata);
  g_assert_null(record.environment);
  g_assert_cmpint(record.count, ==, 0);
}

static void test_rejects_wrong_field_types(void) {
  static const struct {
    const char *input;
    const char *message;
  } cases[] = {
      {"name = 1\n", "field name must be a string"},
      {"tags = \"c23\"\n", "field tags must be an array"},
      {"metadata = []\n", "field metadata must be a table"},
      {"environment = 1\n",
       "field environment must be a table or an array of assignments"},
      {"count = \"23\"\n", "field count must be an integer"},
  };
  for (size_t index = 0; index < G_N_ELEMENTS(cases); index++) {
    g_auto(toml_result_t) parsed =
        toml_parse(cases[index].input, (int)strlen(cases[index].input));
    g_assert_true(parsed.ok);

    TestRecord record = {};
    g_autoptr(GError) error = nullptr;
    g_assert_false(ttr_toml_load_fields(parsed.toptab, &record, fields,
                                        G_N_ELEMENTS(fields), &error));
    g_assert_nonnull(error);
    g_assert_cmpstr(error->message, ==, cases[index].message);
    ttr_toml_clear_fields(&record, fields, G_N_ELEMENTS(fields));
  }
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, nullptr);
  g_test_add_func("/toml-schema/all-field-types", test_loads_every_field_type);
  g_test_add_func("/toml-schema/wrong-types", test_rejects_wrong_field_types);
  return g_test_run();
}
