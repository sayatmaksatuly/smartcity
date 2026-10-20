"""Process-local bounds for expensive anonymous API calls; no user/IP tracking."""

import threading
import time
from collections import deque
from contextlib import contextmanager


class RequestLimitError(Exception):
    pass


class RequestGate:
    def __init__(self, max_active: int = 2):
        self._lock = threading.Lock()
        self._starts: deque[float] = deque()
        self._active = 0
        self._max_active = max_active

    def reset(self):
        # Called only during application startup, before accepting requests.
        with self._lock:
            self._starts.clear()
            self._active = 0

    @contextmanager
    def acquire(self, per_minute: int):
        with self._lock:
            now = time.monotonic()
            while self._starts and self._starts[0] <= now - 60:
                self._starts.popleft()
            if len(self._starts) >= per_minute:
                raise RequestLimitError("rate_limited")
            if self._active >= self._max_active:
                raise RequestLimitError("busy")
            self._starts.append(now)
            self._active += 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1
