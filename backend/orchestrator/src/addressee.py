"""Addressee detection — the core of multi-party video (PLATFORM-ROADMAP §2c).

In a 1:1 call every caller turn is for the agent. In a room with real people, the
agent must NOT answer everything humans say to each other — it speaks only when it was
addressed. This module makes that decision from the transcript + who's in the room.

It is a fast heuristic gate in front of the LLM, not a model call: name mention, a
direct question with no other addressee, an imperative aimed at the assistant. It fails
toward SILENCE (an agent that over-speaks in a meeting is worse than one that waits to
be asked again), and it's pure/testable so multi-party logic can be verified without a
live room.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class AddressDecision:
    speak: bool
    confidence: float
    reason: str


_QUESTION = re.compile(r"\?\s*$")
_BACKCHANNEL = re.compile(r"^\s*(mm+|uh+huh|yeah|ok(ay)?|right|got it|i see)\b[.! ]*$", re.I)
# "hey <name>", "<name>, can you", "assistant, ...", "ok <name>"
_WAKE = re.compile(r"\b(hey|ok|okay|hi|so)\s+{name}\b", re.I)


def was_addressed(
    transcript: str,
    *,
    agent_name: str,
    other_participant_names: list[str] | None = None,
    speaker_is_human: bool = True,
) -> AddressDecision:
    """Decide whether the agent should respond to this utterance."""
    text = (transcript or "").strip()
    others = other_participant_names or []

    if not text:
        return AddressDecision(False, 1.0, "empty")
    if not speaker_is_human:
        # The agent doesn't answer itself or another bot.
        return AddressDecision(False, 1.0, "non-human speaker")
    if _BACKCHANNEL.match(text):
        return AddressDecision(False, 0.9, "backchannel")

    name = agent_name.strip() or "assistant"
    name_re = re.escape(name)
    lowered = text.lower()

    # Directly named — the strongest signal.
    if re.search(_WAKE.pattern.format(name=name_re), text, re.I) or re.search(rf"\b{name_re}\b", text, re.I):
        return AddressDecision(True, 0.95, f"named '{name}'")
    if re.search(r"\b(assistant|agent|ai)\b", lowered):
        return AddressDecision(True, 0.8, "addressed the assistant by role")

    # Another human was named — this turn is for them, not the agent.
    for other in others:
        if other and re.search(rf"\b{re.escape(other)}\b", text, re.I):
            return AddressDecision(False, 0.85, f"addressed to {other}")

    # A question with nobody else named, in a small room, is plausibly for the agent.
    if _QUESTION.search(text):
        # The more humans present, the less likely an unaddressed question is for the AI.
        conf = 0.6 if len(others) <= 1 else 0.4
        return AddressDecision(len(others) <= 1, conf, "open question, no other addressee")

    # A statement to the room, no name, no question → stay silent (fail toward silence).
    return AddressDecision(False, 0.6, "not addressed")
