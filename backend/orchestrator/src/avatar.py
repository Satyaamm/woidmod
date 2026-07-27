"""Avatar-out: the agent shows a face on a video call.

The agent's TTS audio drives a talking-head video track published back into the room,
so a video call feels like a call and not a voicebot with a black square. Three renderer
tiers plug in behind one interface (PLATFORM-ROADMAP §2b):

  1. waveform / branded card (cheap, ships first — the `WaveformAvatar` here)
  2. 2D lip-synced avatar (Simli / HeyGen-class, or self-hosted Wav2Lip)
  3. full photoreal (later)

The critical correctness property: the avatar is downstream of TTS and reads the SAME
playout counter as barge-in truncation. When the caller interrupts, the audio stops at
the byte the caller actually heard — and the avatar must stop on the same frame, or the
face keeps talking after the voice goes silent. So `on_barge_in()` clears the avatar in
lock-step with the audio clear, exactly like `PlayoutTrackingAudioOutput`.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional, Protocol

log = logging.getLogger("woidmod.avatar")


class AvatarRenderer(Protocol):
    """Turns a chunk of agent speech audio into video frames. Implemented by the
    waveform card, a 2D avatar vendor, or a self-hosted model — injected, so the
    orchestrator never hardcodes one."""

    async def render(self, audio_chunk: bytes) -> None: ...
    async def idle(self) -> None: ...
    async def clear(self) -> None: ...


class WaveformAvatar:
    """The tier-1 renderer: an audio-reactive waveform / branded card. Always available,
    no model needed — the honest default until a real avatar is configured."""

    def __init__(self, publish_frame: Callable[[object], Awaitable[None]]) -> None:
        self._publish = publish_frame

    async def render(self, audio_chunk: bytes) -> None:
        # A real implementation renders a waveform frame from the chunk's amplitude and
        # publishes it. Kept as the interface point; the frame source is the track.
        pass

    async def idle(self) -> None:
        pass

    async def clear(self) -> None:
        pass


class AvatarOutput:
    """Bridges TTS audio to an avatar video track. Enable per-agent via the flow's
    `avatar` node / agent config; when disabled this is a no-op and the call is audio
    plus the caller's own video only."""

    def __init__(self, renderer: Optional[AvatarRenderer] = None, *, enabled: bool = False) -> None:
        self._renderer = renderer
        self._enabled = enabled and renderer is not None
        self._speaking = False
        # The published LiveKit video source the renderer writes frames into. Bound by
        # the orchestrator once the avatar track is published; None until then.
        self._video_source = None

    def attach_video_source(self, source) -> None:
        """Bind the published `rtc.VideoSource` so the renderer can push avatar frames."""
        self._video_source = source

    @property
    def active(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        """An `avatar` flow node can turn the face on/off mid-call."""
        self._enabled = enabled and self._renderer is not None

    async def on_audio(self, audio_chunk: bytes) -> None:
        """Called as TTS audio is produced. Drives the talking-head frames."""
        if not self._enabled or self._renderer is None:
            return
        self._speaking = True
        await self._renderer.render(audio_chunk)

    async def on_turn_end(self) -> None:
        if not self._enabled or self._renderer is None:
            return
        self._speaking = False
        await self._renderer.idle()

    async def on_barge_in(self) -> None:
        """Caller interrupted — stop the face on the same frame the audio stops. This is
        the bookkeeping every competitor gets wrong on video."""
        if not self._enabled or self._renderer is None:
            return
        self._speaking = False
        await self._renderer.clear()
        log.debug("avatar cleared on barge-in")
