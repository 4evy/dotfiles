import operator
from collections.abc import Callable

from tenacity import (
    RetryCallState,
    Retrying,
    retry_if_result,
    stop_after_attempt,
    wait_fixed,
)


def _return_false(_retry_state: RetryCallState) -> bool:
    return False


def wait_until(
    predicate: Callable[[], bool],
    *,
    attempts: int,
    interval: float,
) -> bool:
    """Poll a predicate with a bounded number of fixed-interval attempts."""
    retrying = Retrying(
        retry=retry_if_result(operator.not_),
        stop=stop_after_attempt(attempts),
        wait=wait_fixed(interval),
        retry_error_callback=_return_false,
    )
    return bool(retrying(predicate))
