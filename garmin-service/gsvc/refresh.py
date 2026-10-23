"""On-demand refresh: what `POST /refresh` runs when a person presses refresh in the app.

One fetch at a time. A request that arrives while a fetch is running waits for it and gets its result (so a double tap is one Garmin round trip, not two); a request
that arrives more than `MIN_GAP_S` after the last one always starts a fresh fetch. Nothing is cached across refreshes: every press reads Garmin again.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

MIN_GAP_S = 3.0  # only to absorb a double tap; a real second press is a new Garmin call


class Refresher:
    def __init__(self, run: Callable[[], dict], clock=time.monotonic):
        self._run, self._clock = run, clock
        self._lock = threading.Lock()
        self._done = 0  # completed fetches, so a waiter can tell whether one finished while it waited
        self._last: dict | None = None
        self._last_end = 0.0

    def refresh(self) -> dict:
        seen = self._done
        with self._lock:
            if self._last is not None and (self._done != seen or self._clock() - self._last_end < MIN_GAP_S):
                return {**self._last, "shared": True}
            res = self._run()
            self._last, self._last_end = res, self._clock()
            self._done += 1
            return {**res, "shared": False}
