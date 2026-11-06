"""A global, lease-based limit on concurrent calls to the shared model proxy made by the document STUDY (it reads several windows at once,
several jobs and users run at once, and the proxy answers 429 under load). Only the study's calls take a lease and are counted: the job's own
scoring and authoring calls take none. The study therefore backs off reactively, on its own 429s (it lowers its workers and wins them back
additively; see app.leveling.study_runner); a pressure signal shared with the job's own calls is a possible later step.

A call holds a lease for its whole duration: one slot of its user and one global slot, each a Redis key holding the holder's random token
and written with a TTL. A worker that dies therefore frees its slots when the TTL runs out, and a call that hangs past the TTL only loses its
protection (admitting one call too many is harmless; never freeing a slot is not). Every operation touches ONE key, so it is safe on any
Redis or Valkey topology: a slot is taken with SET NX PX and given back with a compare-and-delete, which never frees a lease that expired and
was taken by someone else. Per-user slots keep one user from holding every global slot, and a user slot is never held while waiting for a
global one. Keys carry the hashed user scope (app.request_identity.user_scope) and a short hash of the model, never the raw ids.

Fail open, like app.leveling.study_store: with no Redis client, or after any Redis error, `acquire` hands out local leases that hold no
Redis state (the caller stays limited only by its own caps) and the limiter stops calling Redis for a cooldown, then probes it again on
the next `acquire` (one warning per limiter, type only, and one info line when Redis is back). If the server has Lua scripting disabled the
release would fail and keep filling the slots for ten minutes at a time, so the first `acquire` probes it (`return 1`) and goes local with
one error line when it is unavailable; a release is always attempted, and one that fails leaves the slots to their TTL and starts the same cooldown.

Thread use: unlike StudyStore, one limiter is shared by the worker threads of a job; `acquire` and `Lease.release` may run on any of
them. The only shared mutable state is the "down until" time, the probe and the one-time warnings, guarded by a lock."""
from __future__ import annotations

import hashlib
import logging
import math
import random
import threading
import time
import uuid
from collections.abc import Callable

from app.job_cancel import raise_if_cancelled

logger = logging.getLogger(__name__)

_RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

_PROBE_SCRIPT = "return 1"  # run once per limiter: a server that cannot run the release script must not be given a slot it could never free

_POLL_SECONDS = 0.5  # the first wait between two tries of one acquire; every further miss waits _POLL_BACKOFF times longer, up to _MAX_POLL_SECONDS
_POLL_BACKOFF = 1.5
_MAX_POLL_SECONDS = 2.0
_MAX_SLICE_SECONDS = 1.0  # a wait is slept in slices of at most this, so a cancellation is seen within it


class Lease:
    """The slots one call holds (none for a local lease). Release it when the call ends, or use it as a context manager; releasing twice does nothing."""

    def __init__(self, limiter: LeaseLimiter | None = None, held: tuple[tuple[str, str], ...] = ()) -> None:
        self._limiter = limiter
        self._held = held
        self._released = False

    def release(self) -> None:
        """Gives each slot back only if this lease still owns it; when that fails the slots are left to expire on their own."""
        if self._released:
            return
        self._released = True
        if self._limiter is not None:
            self._limiter._release(self._held)

    def __enter__(self) -> Lease:
        return self

    def __exit__(self, *exc_info) -> None:
        self.release()


class LeaseLimiter:
    """`redis_client` is any object with set(key, value, px=..., nx=...) and eval(script, numkeys, key, token) (redis.Redis), or None for no accounting."""

    def __init__(self, redis_client, global_slots: int, user_slots: int, lease_seconds: int, cooldown_seconds: float = 60.0) -> None:
        self._redis = redis_client
        self._global_slots = global_slots
        self._user_slots = user_slots
        self._lease_ms = int(lease_seconds * 1000)
        self._cooldown = cooldown_seconds
        self._clock: Callable[[], float] = time.monotonic  # the clock of the latest acquire, so a release can start the cooldown too
        self._down_until = math.inf if redis_client is None else -math.inf  # local leases are served until then
        self._probed = False
        self._warned = False
        self._lock = threading.Lock()

    def _fail(self, action: str, error: Exception) -> None:
        """Redis is treated as absent for the cooldown; one warning per limiter, never the key or the error text (it may carry the key)."""
        with self._lock:
            self._down_until = self._clock() + self._cooldown
            if self._warned:
                return
            self._warned = True
        logger.warning("Model lease limiter unavailable (%s: %s); model calls run without a global limit.", action, type(error).__name__)

    def _lua_available(self) -> bool:
        """Probes once (remembered for the limiter's life) that the server runs scripts; on failure goes local for the cooldown with one error line."""
        with self._lock:
            if self._probed:
                return True
        try:
            self._redis.eval(_PROBE_SCRIPT, 0)  # outside the lock, so a slow server never blocks other workers; a duplicate probe is harmless
        except Exception as error:  # noqa: BLE001 -- fail open
            with self._lock:
                self._down_until = self._clock() + self._cooldown
            failure = type(error).__name__
        else:
            with self._lock:
                self._probed = True
            return True
        logger.error("Model lease limiter disabled: Lua scripting is unavailable (%s); model calls run without a global limit.", failure)
        return False

    def _take(self, prefix: str, slots: int, rng: random.Random) -> tuple[str, str] | None:
        """Takes the first free slot, scanning from a random start; returns (key, token) or None when all are held."""
        token = uuid.uuid4().hex
        start = rng.randrange(slots)
        for i in range(slots):
            key = f"{prefix}:{(start + i) % slots}"
            if self._redis.set(key, token, px=self._lease_ms, nx=True):
                return key, token
        return None

    def _try_once(self, model_hash: str, scope: str, rng: random.Random) -> Lease | None:
        user = self._take(f"llmlease:u:{scope}:{model_hash}", self._user_slots, rng)
        if user is None:
            return None
        try:
            glob = self._take(f"llmlease:g:{model_hash}", self._global_slots, rng)
        except BaseException:
            self._release((user,))
            raise
        if glob is None:
            self._release((user,))  # never hold a user slot while blocked on the global ones
            return None
        return Lease(self, (user, glob))

    def acquire(
        self, model: str | None, scope: str, max_wait_seconds: float, *,
        sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic, rng: random.Random | None = None,
    ) -> Lease | None:
        """A lease on one user slot and one global slot, or None when none could be had within `max_wait_seconds`. `scope` is the already-hashed
        user_scope(user_id). Raises JobCancelled while waiting if the run is cancelled; nothing is held then."""
        rng = rng or random.Random()
        self._clock = clock
        model_hash = hashlib.sha256((model or "default").encode("utf-8")).hexdigest()[:12]
        deadline = clock() + max_wait_seconds
        interval = _POLL_SECONDS
        while True:
            recovering = self._down_until != -math.inf
            if clock() < self._down_until:
                return Lease()
            if not self._lua_available():
                return Lease()
            try:
                lease = self._try_once(model_hash, scope, rng)
            except Exception as error:  # noqa: BLE001 -- fail open
                self._fail("acquire", error)
                return Lease()
            if recovering:
                with self._lock:
                    self._down_until = -math.inf
                logger.info("Model lease limiter is available again; global limiting resumed.")
            if lease is not None:
                return lease
            remaining = deadline - clock()
            if remaining <= 0:
                return None
            wait = min(interval * rng.uniform(0.5, 1.5), _MAX_POLL_SECONDS, remaining)
            interval = min(interval * _POLL_BACKOFF, _MAX_POLL_SECONDS)  # a waiter that keeps missing polls less often: fewer Redis commands while the slots stay taken
            while wait > 0:
                raise_if_cancelled()
                piece = min(wait, _MAX_SLICE_SECONDS)
                sleep(piece)
                wait -= piece

    def _release(self, held: tuple[tuple[str, str], ...]) -> None:
        if self._redis is None:
            return
        for key, token in held:  # always attempted, whatever the cooldown: it only stops acquires, and a held slot must not wait for its TTL
            try:
                self._redis.eval(_RELEASE_SCRIPT, 1, key, token)
            except Exception as error:  # noqa: BLE001 -- the keys expire on their own
                self._fail("release", error)
                return
