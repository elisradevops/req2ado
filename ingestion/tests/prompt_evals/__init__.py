"""Behavioral evaluation of SURVEY's prompts: each case runs a real OrchestratorLlmClient method and checks properties of the answer.

Offline (pytest), every case runs against a scripted good model and a scripted bad model, which proves each check can pass and can fail. Live
(`python -m tests.prompt_evals.run`), the same cases run against a real model route and the report becomes the baseline that later prompt
versions are gated on (`python -m tests.prompt_evals.compare`). Every fixture here is synthetic: no customer text."""
