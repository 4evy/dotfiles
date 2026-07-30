#include "support/test-support.h"

#include <glib.h>

void ttr_assert_strv_equal(char *const *actual, const char *const *expected) {
  size_t index = 0;
  for (; expected[index] != nullptr; index++) {
    g_assert_cmpstr(actual[index], ==, expected[index]);
  }
  g_assert_null(actual[index]);
}
