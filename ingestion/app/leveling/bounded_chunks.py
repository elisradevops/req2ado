from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Generic, NamedTuple, TypeVar

T = TypeVar("T")
R = TypeVar("R")


class ChunkOutcome(NamedTuple, Generic[R]):
    """One chunk's result as plain data, carried back to the CALLING thread
    for an in-order merge.

    Exactly one of `value`/`error` is meaningful, but `value is None` is NOT
    the failure signal -- a worker legitimately returning None is a normal
    outcome. Callers must branch on `error is not None`.

    `chunk_index` is the chunk's own submission (document) position, carried
    explicitly rather than left implicit in list position, so a merge loop
    can build its narration text ("chunk N of M") from the same number
    regardless of how the outcomes were gathered. Named `chunk_index` rather
    than the more obvious `index` because a NamedTuple field called `index`
    shadows `tuple.index` with an incompatible signature.

    Generic in the worker's own return type, so a merge loop that reads
    `outcome.value` gets the worker's real type back instead of a bare
    `object`."""

    chunk_index: int
    value: R | None
    error: BaseException | None


def run_chunks_bounded(
    chunks: Sequence[T],
    worker: Callable[[T], R],
    concurrency: int,
) -> Iterator[ChunkOutcome[R]]:
    """Runs `worker` over every chunk with at most `concurrency` in flight,
    and YIELDS one ChunkOutcome per chunk in SUBMISSION order -- never in
    completion order.

    Lazy on purpose (a generator, not a list). Every caller narrates its
    own per-chunk progress event immediately before pulling that chunk's
    outcome; an eager helper would force all of a pass's narration to fire
    back-to-back before the first call even left the calling thread, which
    is exactly the "progress bar jumps to ~94% and then freezes for
    minutes" symptom that per-chunk narration was added to fix (see
    _apply_title_tag_pass's own comment). Laziness is what keeps the
    narrate -> call -> narrate -> call interleave intact.

    This is the chunk-level counterpart to the branch-level fan-out
    llm_leveling.py already performs inline in three places (its own
    `_run`/`_author_branch_content`/stage-1 loops). Extracted as a shared
    helper here rather than inlined a fourth, fifth, and sixth time because
    five call sites across two modules need the identical
    submit/collect-by-index/exception-as-data shape, and because that shape
    is what makes concurrency provably output-neutral rather than
    output-neutral by luck. The three pre-existing inline sites are
    deliberately left alone.

    Two guarantees the callers depend on:

    1. `concurrency <= 1` (or a single chunk) is the byte-identical old
       code path -- a plain loop on the CALLING thread, with no
       ThreadPoolExecutor constructed at all. Same "zero new risk for every
       deployment that hasn't opted into concurrency" property
       llm_leveling.py's own `if branch_concurrency <= 1` guards give.
    2. NOTHING raises out of this function. Every one of the passes that
       uses it is already fail-soft per chunk (a failed chunk gets an
       IntegrityWarning plus a `chunk_warning` narration event, and the
       remaining chunks still apply) -- so a fan-in that re-raised on the
       first failure would be a behavior regression, not a design choice.
       The exception comes back as data and the caller's own existing
       `except` body runs on the calling thread, in chunk order.

    Deliberately does NOT fire progress narration, take a lock, or mutate
    anything: every caller keeps all of that on the calling thread, so
    narration stays in document order and needs no synchronization -- the
    same reasoning _map_figures_tables_to_nodes' own `_fire_map_scope`
    comment already spells out."""
    if concurrency <= 1 or len(chunks) <= 1:
        for index, chunk in enumerate(chunks):
            yield _run_one(index, chunk, worker)
        return
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [
            executor.submit(_run_one, index, chunk, worker)
            for index, chunk in enumerate(chunks)
        ]
        # Yielded by INDEX (list position of the future), never by
        # completion order -- see this function's own docstring.
        for future in futures:
            yield future.result()


def _run_one(index: int, chunk: T, worker: Callable[[T], R]) -> ChunkOutcome[R]:
    try:
        return ChunkOutcome(chunk_index=index, value=worker(chunk), error=None)
    except Exception as exc:  # noqa: BLE001 - exception-as-data is this helper's whole contract
        return ChunkOutcome(chunk_index=index, value=None, error=exc)
