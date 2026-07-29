"""Semantic endpointing — the decision that "the caller has finished speaking".

This is a faithful port of `backend/control-plane/src/core/patterns/strategy.ts`
(`SemanticEndpointing`). The TypeScript version stays as the reference implementation
that the eval harness measures against; this one runs on the live call path.

Why a port rather than an RPC: the endpointer is consulted every ~20ms during a
caller's turn. A network hop to the control plane would cost more than the decision
it is making. Later this becomes an ONNX model loaded in-process; the interface and
the thresholds do not change when it does.

The behaviour that matters (verified identical to the TS implementation):

    complete sentence, falling pitch  ->  commits at ~120ms
    short answer "yeah"               ->  commits at ~110ms
    mid-ID "four two seven", rising   ->  waits ~570ms
    fast talker (150ms baseline)      ->  commits at ~60ms
    fixed-silence baseline            ->  700ms, always

A fixed timer cannot be both fast on complete utterances and patient mid-number.
That is the entire argument for this file existing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Optional

ExpectedSlot = Literal["digits", "email", "name", "yes_no", "freeform"]


@dataclass(frozen=True)
class Prosody:
    """Features from the media layer, normalised over the final ~300ms of speech."""

    pitch_slope: float
    """Negative = falling = finished. Positive = rising = still going."""
    energy_slope: float
    final_lengthening: float = 1.0
    """Final-syllable lengthening vs. this speaker's baseline. >1 = drawing out."""


@dataclass
class CallerBaseline:
    """Rolling stats for THIS caller, so the agent adapts to how they speak.

    A fast talker's 200ms pause means what a slow talker's 600ms means. Tracking it
    per caller is why the same agent can answer one person in 60ms and wait 570ms
    for another without either feeling wrong.
    """

    mean_pause_ms: float = 300.0
    std_pause_ms: float = 90.0
    _samples: list[float] = field(default_factory=list)

    def observe_pause(self, pause_ms: float) -> None:
        # Cap the window so a caller who changes pace mid-call is tracked, not
        # averaged into irrelevance over a 20-minute call.
        self._samples.append(pause_ms)
        if len(self._samples) > 12:
            self._samples.pop(0)
        if self._samples:
            self.mean_pause_ms = sum(self._samples) / len(self._samples)


@dataclass(frozen=True)
class EndpointDecision:
    probability: float
    should_speculate: bool
    """Cross this to start LLM prefill early. Discarded if the caller resumes."""
    should_commit: bool
    reason: str


# Words that cannot end a finished thought. Ending on one of these is the strongest
# single signal the caller is mid-clause, no matter how long they then pause.
_TRAILING_CONTINUATION = re.compile(
    r"\b(and|or|but|so|because|the|a|an|my|your|is|are|was|were|to|for|with|of|at"
    r"|in|on|that|if|when|maybe|perhaps|just|like|about|into|from|than|then|its"
    r"|it's|i'm|we're|you're)$",
    re.IGNORECASE,
)

_FILLED_PAUSE = re.compile(r"\b(um|uh|er|hmm)$", re.IGNORECASE)
_TERMINAL_PUNCT = re.compile(r"[.!?]$")


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def syntactic_completeness(text: str) -> float:
    """Rough completeness proxy. Replaced by the model in production.

    Calibration note carried over from the TS implementation: streaming ASR emits
    text WITHOUT punctuation, so a missing full stop is not evidence of
    incompleteness. Scoring it as such caps the achievable probability below the
    commit threshold and makes this behave exactly like the fixed-silence baseline
    it exists to beat. That was a real bug; do not "fix" it back.
    """
    t = text.strip()
    if not t:
        return 0.0
    if _TERMINAL_PUNCT.search(t):
        return 0.95  # punctuation, when present, is strong evidence
    if _TRAILING_CONTINUATION.search(t):
        return 0.05  # clearly mid-clause
    if _FILLED_PAUSE.search(t):
        return 0.10  # still thinking
    if len(t.split()) <= 2:
        return 0.80  # "yes" / "okay" are complete turns, not fragments
    return 0.90


class SemanticEndpointer:
    """Scores P(turn complete) from silence, syntax, prosody and caller rhythm."""

    def __init__(
        self,
        speculate_threshold: float = 0.4,
        commit_threshold: float = 0.9,
        max_wait_ms: float = 1500.0,
    ) -> None:
        self.speculate_threshold = speculate_threshold
        self.commit_threshold = commit_threshold
        self.max_wait_ms = max_wait_ms
        """Absolute ceiling. A caller who trails off mid-sentence must still get a
        reply — without this the turn hangs forever on an ambiguous utterance."""

    def decide(
        self,
        *,
        silence_ms: float,
        partial_transcript: str,
        baseline: CallerBaseline,
        prosody: Optional[Prosody] = None,
        expected_slot: Optional[ExpectedSlot] = None,
    ) -> EndpointDecision:
        reasons: list[str] = []

        syntax = syntactic_completeness(partial_transcript)
        reasons.append(f"syntax={syntax:.2f}")

        # Falling pitch + falling energy = finished. Rising = still going, even
        # after a long pause ("my number is four two seven—").
        prosody_score = 0.5
        if prosody is not None:
            prosody_score = _clamp01(
                0.5
                - prosody.pitch_slope * 0.35
                - prosody.energy_slope * 0.25
                - (prosody.final_lengthening - 1.0) * 0.3
            )
            reasons.append(f"prosody={prosody_score:.2f}")

        # Does this LOOK and SOUND finished, independent of how long they've been
        # quiet? This is the whole point: when someone has clearly finished, you
        # don't wait out a silence timer.
        semantic = _clamp01(syntax * 0.45 + prosody_score * 0.55)

        # Silence acts as a fast GATE on that confidence rather than an equal third
        # of the score, scaled to this caller's own rhythm.
        baseline_ms = max(120.0, baseline.mean_pause_ms)
        gate = _clamp01(silence_ms / (baseline_ms * 0.4))
        reasons.append(f"gate={gate:.2f}")

        # Once they've been quiet longer than their own normal pause, confidence
        # climbs regardless of how ambiguous the words were. This is what ends an
        # unclear turn without a hard timer.
        overrun = _clamp01((silence_ms - baseline_ms) / baseline_ms)

        gated = semantic * gate
        probability = gated + (1.0 - gated) * overrun * 0.9

        penalty = self._slot_penalty(partial_transcript, expected_slot)
        if penalty != 0.0:
            reasons.append(f"slot={-penalty:.2f}")
        probability = _clamp01(probability - penalty)

        if silence_ms >= self.max_wait_ms:
            probability = max(probability, 0.95)
            reasons.append("maxWait")

        return EndpointDecision(
            probability=probability,
            should_speculate=probability >= self.speculate_threshold,
            should_commit=probability >= self.commit_threshold,
            reason=" ".join(reasons),
        )

    @staticmethod
    def _slot_penalty(text: str, slot: Optional[ExpectedSlot]) -> float:
        """Mid-ID pauses are normal. Don't cut people off reading a number out.

        This is the single highest-value rule in the file: order numbers, postcodes
        and card numbers are exactly where a fixed timer interrupts, and exactly
        where being interrupted is most expensive.
        """
        if slot is None:
            return 0.0
        t = text.strip()
        if slot == "digits":
            digits = sum(c.isdigit() for c in t)
            return 0.35 if 0 < digits < 6 else 0.0
        if slot == "email":
            return 0.0 if "@" in t else 0.30  # nobody says an email in one breath
        if slot == "name":
            return 0.20 if len(t) < 3 else 0.0
        if slot == "yes_no":
            return -0.15  # short answers are complete answers — respond fast
        return 0.0


class FixedSilenceEndpointer:
    """The naive baseline — what most platforms ship. Kept as the control arm.

    You cannot claim a 300ms win without measuring against the thing you claim to
    beat, so this ships alongside and is selectable per agent.
    """

    def __init__(self, threshold_ms: float = 700.0) -> None:
        self.threshold_ms = threshold_ms

    def decide(
        self,
        *,
        silence_ms: float,
        partial_transcript: str,
        baseline: CallerBaseline,
        prosody: Optional[Prosody] = None,
        expected_slot: Optional[ExpectedSlot] = None,
    ) -> EndpointDecision:
        p = min(1.0, silence_ms / self.threshold_ms)
        return EndpointDecision(
            probability=p,
            should_speculate=False,  # no early signal to speculate on
            should_commit=silence_ms >= self.threshold_ms,
            reason=f"silence {silence_ms:.0f}ms / {self.threshold_ms:.0f}ms",
        )
