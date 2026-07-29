"""Adapter exposing our endpointer through LiveKit's turn-detection protocol.

LiveKit Agents accepts any object satisfying `_StreamingTurnDetector` as
`turn_handling={"turn_detection": <obj>}`. That is a documented extension point, so
we plug in without forking — we get their VAD plumbing, transcript buffering and
min/max delay gating, and they get our decision.

Why not use theirs: LiveKit's audio turn detector v1 runs on **LiveKit Inference over
a WebSocket** (`{base_url}/eot`). Self-hosted you silently fall back to `v1-mini`.
It also requires a VAD with `min_silence_duration >= 0.25s`, so it structurally
cannot commit below 250ms. Ours commits a complete utterance at ~120ms.

⚠️ LiveKit 1.6.x is mid-rename and these protocols are underscore-private with a
`TODO: move to EOU ctor` in their source. This file is the ONLY place that touches
them, so a LiveKit bump is a one-file change. Pin the version.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from .endpointer import (
    CallerBaseline,
    ExpectedSlot,
    FixedSilenceEndpointer,
    Prosody,
    SemanticEndpointer,
)


@dataclass
class TurnEvent:
    """Mirrors LiveKit's `TurnDetectionEvent`.

    `backchannel_probability` is worth populating even though we don't use it
    ourselves — LiveKit's backchannel-boundary suppression keys off it, so filling
    it in gets us their "ignore 'mhm' in the first/last second of an agent turn"
    behaviour for free.
    """

    end_of_turn_probability: float
    last_speaking_time: float
    detection_delay: float
    inference_duration: float
    backchannel_probability: float = 0.0
    reason: str = ""


# Short affirmations that keep a conversation moving without claiming the floor.
# Treated as backchannels rather than turns — responding to "mhm" with a full reply
# is one of the most common ways a voice agent feels wrong.
_BACKCHANNELS = {
    "mhm", "mm", "mmhmm", "uh huh", "uh-huh", "yeah", "yep", "yup", "right",
    "ok", "okay", "sure", "i see", "got it", "gotcha", "hmm",
}


class SemanticTurnDetector:
    """Implements LiveKit's streaming turn-detector protocol over our endpointer."""

    def __init__(
        self,
        *,
        strategy: str = "semantic",
        commit_threshold: float = 0.9,
        speculate_threshold: float = 0.4,
        on_speculate=None,
        on_score=None,
    ) -> None:
        self._impl = (
            SemanticEndpointer(
                speculate_threshold=speculate_threshold,
                commit_threshold=commit_threshold,
            )
            if strategy == "semantic"
            else FixedSilenceEndpointer()
        )
        self.strategy = strategy
        self._baseline = CallerBaseline()
        self._expected_slot: Optional[ExpectedSlot] = None
        self._transcript = ""
        self._last_speech_at = time.monotonic()
        self._speculated_for_turn = False

        # Callbacks so the agent can fire speculative prefill and emit trace events
        # without this class importing the agent.
        self._on_speculate = on_speculate
        self._on_score = on_score

    # -- state fed by the agent ------------------------------------------------

    def set_expected_slot(self, slot: Optional[ExpectedSlot]) -> None:
        """The dialogue layer tells us what it's waiting for.

        This is the highest-value signal in the whole detector: knowing the caller
        is mid-order-number is what stops us interrupting them at 300ms.
        """
        self._expected_slot = slot

    def update_transcript(self, text: str) -> None:
        self._transcript = text

    def mark_speech(self) -> None:
        now = time.monotonic()
        pause_ms = (now - self._last_speech_at) * 1000.0
        # Only learn from plausible inter-utterance pauses. A 4-second gap is the
        # caller thinking or distracted, not their conversational rhythm.
        if 80.0 <= pause_ms <= 2000.0:
            self._baseline.observe_pause(pause_ms)
        self._last_speech_at = now

    def begin_turn(self) -> None:
        self._speculated_for_turn = False
        self._transcript = ""

    # -- LiveKit protocol ------------------------------------------------------

    def unlikely_threshold(self, language: str | None = None) -> float:
        return self._impl.commit_threshold if hasattr(self._impl, "commit_threshold") else 0.9

    def backchannel_threshold(self, language: str | None = None) -> float:
        return 0.6

    def supports_language(self, language: str | None) -> bool:
        # The heuristic is English-calibrated (the continuation-word list is
        # English). Prosody and silence generalise; syntax does not. Returning True
        # everywhere would quietly ship a worse detector to German callers, so we
        # are honest and let LiveKit fall back for unsupported languages.
        return language is None or language.lower().startswith("en")

    async def predict(
        self,
        *,
        silence_ms: Optional[float] = None,
        prosody: Optional[Prosody] = None,
    ) -> TurnEvent:
        started = time.monotonic()
        elapsed_ms = (
            silence_ms
            if silence_ms is not None
            else (started - self._last_speech_at) * 1000.0
        )

        decision = self._impl.decide(
            silence_ms=elapsed_ms,
            partial_transcript=self._transcript,
            baseline=self._baseline,
            prosody=prosody,
            expected_slot=self._expected_slot,
        )

        # Fire prefill ONCE per turn. If the caller resumes, the agent cancels it
        # and `begin_turn()` re-arms — costing a few ms of wasted GPU for 100-200ms
        # off time-to-first-token.
        if (
            decision.should_speculate
            and not self._speculated_for_turn
            and self._on_speculate is not None
        ):
            self._speculated_for_turn = True
            self._on_speculate(decision.probability, self._transcript)

        if self._on_score is not None:
            self._on_score(decision.probability, decision.reason)

        inference_ms = (time.monotonic() - started) * 1000.0
        return TurnEvent(
            end_of_turn_probability=decision.probability,
            last_speaking_time=self._last_speech_at,
            detection_delay=elapsed_ms / 1000.0,
            inference_duration=inference_ms / 1000.0,
            backchannel_probability=self._backchannel_probability(),
            reason=decision.reason,
        )

    def _backchannel_probability(self) -> float:
        t = self._transcript.strip().lower().rstrip(".,!?")
        if not t:
            return 0.0
        if t in _BACKCHANNELS:
            return 0.9
        # A trailing backchannel on a longer utterance is not a backchannel — the
        # caller said something and then agreed with themselves.
        return 0.0

    @property
    def baseline_ms(self) -> float:
        """Exposed for the trace viewer — shows the agent adapting per caller."""
        return self._baseline.mean_pause_ms
