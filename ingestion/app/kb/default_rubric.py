"""The rubric a job is judged against when the user has no knowledge base (or a knowledge base that yields no categories).

It is built in, versioned and visible: a `KbProfile` of the same shape as one derived from KB documents, so scoring, the per-item
definitions, the chat, the rewrite check and the explanation of a score all work the same way for every user. It only judges and explains;
it is never an authoring standard (that is the organization's, and comes from its knowledge base).

The qualities are the ones the requirements-engineering standards agree on (ISO/IEC/IEEE 29148, the INCOSE guide to writing requirements,
EARS): a requirement is necessary, unambiguous, singular, verifiable, complete, implementation-free, consistent and traceable. Changing the
text below changes DEFAULT_RUBRIC_VERSION: the version is part of the job result cache key, so results scored with an older rubric are not served."""
from __future__ import annotations

from app.kb.profile import Category, KbProfile, TypeDefinition

DEFAULT_RUBRIC_VERSION = "default-rubric-1"

DESIGN_PHILOSOPHY = """Work items form a hierarchy, and each level answers a different question.
- An Epic states an outcome or capability area and why it matters to the stakeholders. It is larger than one piece of work and is made concrete by its Features.
- A Feature is one coherent function or behaviour that delivers part of an Epic and can be understood and reviewed on its own.
- A Requirement is one verifiable statement of need about the system: who or what must do something, under which condition and by how much, in words that two readers cannot understand differently.
A good requirement (ISO/IEC/IEEE 29148, the INCOSE guide to writing requirements, EARS) is necessary, unambiguous, singular, verifiable, complete, implementation-free, consistent and traceable.
Judge what the text says, not what the reader could guess: a missing value, unit, actor or condition is a defect of the requirement, not something to assume. A requirement is not a heading, a label, a table cell, a rationale or an open question."""

_RUBRIC: list[tuple[str, str, str]] = [
    (
        "Necessary",
        "States a need that matters to a stakeholder; the reason it exists is given, or obvious from the text.",
        "Add one sentence saying why the requirement exists, or remove it if no stakeholder needs it.",
    ),
    (
        "Unambiguous",
        "Has one reading only: no vague terms (fast, user-friendly, adequate, as appropriate), no unclear pronouns, and the same word always means the same thing.",
        "Replace each vague word with a measurable one and name the subject explicitly.",
    ),
    (
        "Singular",
        "Says one thing: one actor, one action and one condition; no 'and' or 'or' joining separate needs.",
        "Split it into separate requirements, one per need.",
    ),
    (
        "Verifiable",
        "Can be proven by test, inspection, analysis or demonstration, because it has a measurable acceptance criterion.",
        "Add the measurable limit (value, unit, tolerance) and the condition under which it is checked.",
    ),
    (
        "Complete",
        "Contains everything needed to implement and verify it: subject, 'shall', action, conditions, and values with their units; no TBD or placeholders.",
        "Fill in the missing actor, condition, value or unit, or resolve the open item.",
    ),
    (
        "Implementation-free",
        "States WHAT the system must do or achieve, not HOW it is to be built, unless a design choice is itself a constraint.",
        "Describe the outcome the user or system needs and move the solution detail into the design.",
    ),
    (
        "Consistent",
        "Does not contradict its neighbouring requirements or the document, and uses the same names for the same things.",
        "Align the values and terms with the related requirements, or resolve the conflict with them.",
    ),
    (
        "Traceable",
        "Can be tied to its source (a stakeholder need or its parent item) and referred to by a stable identifier.",
        "Link it to the parent Feature or source need and give it an identifier.",
    ),
]

_TYPES = [
    TypeDefinition(item_type="epic", text="An outcome or capability area and why it matters to the stakeholders, made concrete by its Features.", sources=["built-in"]),
    TypeDefinition(item_type="feature", text="One coherent function or behaviour that delivers part of an Epic and can be reviewed on its own.", sources=["built-in"]),
    TypeDefinition(item_type="requirement", text="One verifiable statement of need about the system, in words that cannot be understood two ways.", sources=["built-in"]),
]


def default_profile() -> KbProfile:
    """A fresh object each call (callers may adjust a copy)."""
    return KbProfile(
        version=DEFAULT_RUBRIC_VERSION, built_with="built-in", source="default",
        categories=[
            Category(name=name, pass_condition=condition, guidance=guidance, sources=["built-in"], merged_from=[name])
            for name, condition, guidance in _RUBRIC
        ],
        type_definitions=[t.model_copy() for t in _TYPES],
    )
