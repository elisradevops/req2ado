# SURVEY wall-clock performance — investigation and fix

Triggered by a real run: `AirPro_BP_ICD_Revision_0.3.docx` (682 blocks, 39
figures, real ADO + real local Ollama) hit 32+ minutes still inside the
`Analyze` step alone, with no end in sight, before being cancelled for
this investigation. Goal: understand the real bottleneck (not guess) and
fix what's actually fixable, with a scalable design — the target
deployment is a shared Open WebUI/Ollama backend serving 100+ concurrent
human users, not a single dev laptop.

## Root cause, confirmed not guessed

Two independent bottlenecks, **both** real, **both** required to fix
together — fixing only one does nothing:

1. **req2ado's own branch-analysis loop was fully sequential.**
   `build_survey_tree` (`ingestion/app/leveling/llm_leveling.py`) splits a
   large document into independent top-level branches (sections), then
   processed them one at a time in a plain `for` loop — even though no
   branch reads another branch's output during analysis (each is a pure,
   independent `_build_survey_tree_for_branch` call). For a 682-block
   document this meant dozens of sequential real LLM round trips
   (`analyze_section`, then chunked title/tag enhancement and
   leaf-synthesis passes) with zero overlap.

2. **The actual Ollama process serving this dev environment is configured
   for exactly one concurrent generation slot.** Confirmed directly via
   `ps aux`: the running `llama-server` process (Ollama's backend) was
   launched with `-np 1` (llama.cpp's parallel-slot flag) — Ollama's own
   default when `OLLAMA_NUM_PARALLEL` is unset. This means **sending
   concurrent requests to this backend today would not have helped at
   all** — they would simply queue at the single slot, one at a time,
   identical wall-clock time, plus wasted client-side complexity.

Neither fix alone helps:
- Parallelizing req2ado's loop against a single-slot backend: requests
  queue server-side, zero wall-clock benefit.
- Raising the backend's parallel-slot count without parallelizing
  req2ado's own loop: the extra backend capacity sits idle, since
  req2ado never sends more than one request at a time.

**Decision (made with the user):** cancel the dev-environment job rather
than let it keep running single-slot, and build the scalable version
directly — since the real target is a shared, high-throughput production
backend already serving 100+ users, not this dev machine's single-GPU
Ollama.

## What shipped

`ingestion/app/leveling/llm_leveling.py`'s multi-branch loop now supports
bounded concurrency via a new `branch_concurrency` parameter, threaded
from a new `SURVEY_BRANCH_CONCURRENCY` env var
(`ingestion/app/config.py`, default **1** — fully sequential, byte-identical
to the pre-existing behavior when unset).

- **`branch_concurrency <= 1` (default):** unchanged — no
  `ThreadPoolExecutor` even constructed, zero new risk for every
  deployment that hasn't opted in.
- **`branch_concurrency > 1`:** branches are submitted to a
  `ThreadPoolExecutor(max_workers=branch_concurrency)` and their results
  are collected **by branch index**, not by completion order — the final
  tree's node order is identical to what a sequential run would produce
  regardless of which branch's LLM call happens to return first
  (regression-tested: branch 0 artificially delayed past branch 1,
  output order still matches sequential).
- `blocks_done_before` (the per-branch progress-bar offset) is now a
  **precomputed, fixed** per-branch value derived from branch sizes known
  upfront, not a running counter mutated after each branch completes —
  the old pattern is unsafe once branches can finish out of order.
- `progress_callback` (narration → Redis → the live UI) is wrapped in a
  `threading.Lock` when concurrency is enabled, so concurrent branches
  never interleave a single narration write. Negligible cost — narration
  fires far less often than the LLM calls that dominate wall time.
- This is genuinely I/O-bound work (blocking `httpx.Client` calls to an
  HTTP LLM proxy) — Python's GIL releases during socket I/O wait, so a
  `ThreadPoolExecutor` (not `asyncio`, no async rewrite needed) gives real
  concurrency here, not just interleaving.

**Files:** `ingestion/app/config.py`, `ingestion/app/leveling/llm_leveling.py`,
`ingestion/app/main.py` (threads `settings.survey_branch_concurrency`
through), `.env.template`. Tests:
`ingestion/tests/test_llm_leveling.py` (3 new: concurrent-vs-sequential
output parity, out-of-order-completion ordering, per-branch progress
offset correctness).

## What this does NOT do, and why

This is a **client-side fan-out knob**, not a claim of more LLM capacity.
Raising `SURVEY_BRANCH_CONCURRENCY` above what the configured
`LLM_BASE_URL` backend can genuinely serve concurrently does nothing
useful — requests just queue backend-side instead of in req2ado's own
loop, with added connection/scheduling overhead for zero wall-clock gain.

**In production (100+ concurrent Open WebUI users, one shared backend):**
this value must be set in coordination with whoever operates that
backend's own concurrency limit (Ollama's `OLLAMA_NUM_PARALLEL`, or
whatever the production LLM serving layer's equivalent is). Setting
req2ado's concurrency higher than the backend can truly serve doesn't
just fail to help this job — it adds queueing delay for every one of the
other 100 users' own chat requests hitting the same backend. This is a
capacity-planning conversation with the backend operator, not a value to
maximize blindly from req2ado's side.

**Recommended rollout, not yet done (needs the production backend
operator, not a code change):**
1. Confirm the production Ollama/Open WebUI backend's real concurrent
   generation capacity (GPU count, `OLLAMA_NUM_PARALLEL`, or whatever the
   serving layer's own multi-request handling actually is) — measure, don't
   assume from marketing specs.
2. Set `SURVEY_BRANCH_CONCURRENCY` to a fraction of that capacity, not all
   of it — a single SURVEY job is one of potentially many concurrent
   demands on the same backend from the other 100 users' own traffic.
3. Measure a real large-document run end to end before and after, on the
   real production backend, not this dev machine's single-slot Ollama —
   this dev environment cannot demonstrate the actual speedup since it
   has no spare backend capacity to exploit.

## Attempted local empirical validation — inconclusive, confound identified and documented honestly

After shipping the fix, attempted a real head-to-head timing test on this
dev machine: `SURVEY_BRANCH_CONCURRENCY=1` (job `ba8c26d1-...`) vs `=2`,
same real document, using `qwen3:4b` (a dense model, confirmed capable of
Ollama's `-np 2`) instead of the MoE default. This test was **abandoned as
unreliable, not completed as planned** — a real, unrelated confound was
found mid-run:

- The baseline (`concurrency=1`) run's own single LLM call showed a
  catastrophic mid-generation slowdown in Ollama's own server log
  (`~/.ollama/logs/server.log`, `slot print_timing`): **44 tokens/sec at
  the start of generation, degrading to 2.4 tokens/sec** by the same
  call's end — an 18x collapse, on a small 4B model that should generate
  at a roughly constant rate.
- Root cause, confirmed via `sysctl vm.swapusage`: **8GB of this Mac's 9GB
  swap was in use** at the time — genuine memory-pressure thrashing.
- This is **this specific shared dev machine's** condition at the time,
  not a req2ado issue: `docker system df` showed 73GB of Docker images
  cached, and `ps aux` showed several unrelated heavy processes running
  concurrently (multiple Claude Code / Devin.app / Windsurf language-server
  processes, browser automation, Microsoft Teams, Spotify) all competing
  for the same 48GB of unified memory that Ollama's model needs.
- **This confound makes a wall-clock `concurrency=1` vs `=2` comparison
  on this machine, right now, meaningless** — the measured time is
  dominated by unrelated host memory pressure that fluctuates
  independently of req2ado's own scheduling. Reporting a "Nx faster"
  number from this environment would be actively misleading rather than
  evidence.

**Decision:** did not push forward with a confounded comparison just to
produce a number. The feature's correctness is already established by the
unit tests (order preservation under concurrency, correct progress
offsets, output parity with sequential) — that evidence stands on its own
and doesn't depend on this machine's momentary load. A trustworthy
wall-clock comparison needs an otherwise-idle machine (or the real
production backend, which is the actually relevant environment per this
document's own opening framing) — not this dev laptop while several other
heavy local tools are also running.

**Recommendation, unchanged:** validate the real wall-clock improvement
on the production backend (or at minimum a dev machine with nothing else
competing for memory) before relying on any specific measured multiplier.
The code is ready and safe to enable (default remains 1, fully
backward-compatible) whenever that validation happens.

## Other levers investigated, not pursued (with reasons)

- **Model choice:** `LLM_CHAT_MODEL=qwen3.6:35b` is already the
  empirically-fastest model in this codebase's own tested roster (see
  `model_caps.py`'s comments: confirmed ~4x faster than the
  next-best-tested alternative at the same coverage budget). Not a
  low-hanging fruit — already shipped.
- **`think: False` / reasoning disabled, `num_ctx` sized correctly:**
  already shipped in earlier work (S2/S6 of the reliability roadmap) —
  not re-investigated here.
- **Response caching (S11):** doesn't help a document's FIRST run — cache
  only pays off on an exact re-run of already-seen input, which is a
  different scenario from this one (a brand-new document).
- **Reducing chunk size to increase round-trip count:** the opposite of
  what's needed — this codebase's own tuning history (`model_caps.py`,
  `_MAX_SURVEY_BRANCH_BLOCK_COUNT`'s doc comment) already found that
  *fewer, larger* calls beat *more, smaller* ones once round-trip overhead
  dominates, which is exactly the case here.
