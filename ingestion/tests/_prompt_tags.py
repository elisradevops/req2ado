"""The LLM client tags every answer entry with the prompt that produced it (app.workitem.model.PROMPT_KEY); tests that compare an
answer's content strip the tag. The tag itself is tested in test_prompt_provenance."""

from app.workitem.model import PROMPT_KEY


def untagged(entries: dict) -> dict:
    return {
        key: {f: v for f, v in entry.items() if f != PROMPT_KEY}
        if isinstance(entry, dict)
        else entry
        for key, entry in entries.items()
    }
