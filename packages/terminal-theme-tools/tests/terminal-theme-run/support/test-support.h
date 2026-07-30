#ifndef TTR_TEST_SUPPORT_ASSERTIONS_H
#define TTR_TEST_SUPPORT_ASSERTIONS_H

#define TTR_MUTABLE_STRING(value) ((char[]){value})

void ttr_assert_strv_equal(char *const *actual, const char *const *expected);

#endif
