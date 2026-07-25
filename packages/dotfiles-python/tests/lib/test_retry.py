import pytest
from tenacity import Future, RetryError

from workstation.lib.retry import wait_until


def test_wait_until_returns_when_predicate_becomes_true() -> None:
    results = iter((False, False, True))

    assert wait_until(lambda: next(results), attempts=3, interval=0)


def test_wait_until_returns_false_after_last_attempt() -> None:
    calls = 0

    def not_ready() -> bool:
        nonlocal calls
        calls += 1
        return False

    assert not wait_until(not_ready, attempts=3, interval=0)
    assert calls == 3


def test_wait_until_does_not_hide_predicate_errors() -> None:
    def fail() -> bool:
        raise OSError("predicate failed")

    with pytest.raises(OSError, match="predicate failed"):
        wait_until(fail, attempts=3, interval=0)


def test_wait_until_does_not_confuse_predicate_retry_error_with_exhaustion() -> None:
    error = RetryError(Future(1))

    def fail() -> bool:
        raise error

    with pytest.raises(RetryError) as raised:
        wait_until(fail, attempts=3, interval=0)

    assert raised.value is error
