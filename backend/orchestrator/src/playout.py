"""Audio output wrapper that tracks what the caller ACTUALLY heard.

This is the mechanism behind honest barge-in. On interruption we need one number —
how much of the agent's utterance reached the caller's ear — and everything else
(context truncation, the trace viewer's "heard vs generated" marker, turn metrics)
derives from it.

Method, borrowed from LiveKit's own room output and provider-independent:

    played = pushed − (still queued in the audio source + still in our buffer)

It is buffer accounting, not an RTCP receiver report, so it does not account for the
far-end jitter buffer. That overestimates by a few tens of milliseconds. We accept
that deliberately: the alternative is a receiver-side measurement that most
transports don't give us, and erring toward "heard slightly more" is the safe
direction — the agent may repeat a word or two, rather than silently assuming it
said something the caller never got.
"""

from __future__ import annotations

import time
from typing import Callable, Optional

from livekit.agents import io

from .events import TraceEmitter

# Words per minute a TTS voice typically produces, used to convert played-out
# duration into a character offset. Re-estimated per turn from observed audio, so
# this is only the cold-start value.
_DEFAULT_CHARS_PER_SECOND = 14.0


class PlayoutTrackingAudioOutput(io.AudioOutput):
    """Wraps the room's audio output and reports true playout progress."""

    def __init__(
        self,
        inner: io.AudioOutput,
        *,
        on_progress: Callable[[int], None],
        on_interrupted: Callable[[], str],
        trace: TraceEmitter,
    ) -> None:
        super().__init__(next_in_chain=inner, sample_rate=inner.sample_rate)
        self._inner = inner
        self._on_progress = on_progress
        self._on_interrupted = on_interrupted
        self._trace = trace

        self._pushed_seconds = 0.0
        self._pushed_chars = 0
        self._first_frame_at: Optional[float] = None
        self._chars_per_second = _DEFAULT_CHARS_PER_SECOND

    async def capture_frame(self, frame) -> None:
        if self._first_frame_at is None:
            self._first_frame_at = time.monotonic()
            self._trace.emit("tts.first_audio")

        await super().capture_frame(frame)
        self._pushed_seconds += frame.duration

        # Convert elapsed audio into a character offset so the agent can slice its
        # generated text at the right point.
        self._on_progress(int(self._pushed_seconds * self._chars_per_second))

    def note_text(self, text: str) -> None:
        """Called as text is handed to TTS, so we can calibrate chars-per-second.

        Re-estimating per turn matters because speaking rate varies with voice,
        language and the `speed` setting — a fixed constant would drift the
        truncation point on any non-default voice.
        """
        self._pushed_chars += len(text)
        if self._pushed_seconds > 0.5:
            self._chars_per_second = self._pushed_chars / self._pushed_seconds

    def clear_buffer(self) -> None:
        """Barge-in. Everything still queued was never heard."""
        played_seconds = self._played_seconds()
        heard = self._on_interrupted()

        self._trace.emit(
            "tts.cancelled",
            playedOutMs=round(played_seconds * 1000, 1),
            playedOutText=heard[:200],
        )
        super().clear_buffer()
        self._reset()

    def on_playback_finished(self, *, playback_position: float, interrupted: bool) -> None:
        if not interrupted:
            self._trace.emit("tts.done", durationMs=round(playback_position * 1000, 1))
            self._reset()
        super().on_playback_finished(
            playback_position=playback_position, interrupted=interrupted
        )

    def _played_seconds(self) -> float:
        """pushed − still-queued. The one number everything else derives from."""
        queued = getattr(self._inner, "queued_duration", 0.0) or 0.0
        return max(0.0, self._pushed_seconds - queued)

    def _reset(self) -> None:
        self._pushed_seconds = 0.0
        self._pushed_chars = 0
        self._first_frame_at = None
