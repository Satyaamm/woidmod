"""Vision-in: the agent sees the caller's camera or shared screen.

The load-bearing design decision (PLATFORM-ROADMAP §2a): vision is ASYNCHRONOUS to
speech. The voice turn loop never blocks on a frame — a scene description lands as an
out-of-band context update, exactly like a tool result. Frames are the cost driver,
so we sample ADAPTIVELY: a low idle rate, bursting only when the caller says "look at
this" (a `vision` flow node, or motion), then decaying back down.

The VLM itself is injected (`vlm_fn`) so this module is model-agnostic — Claude vision,
GPT-4o-vision, or Gemini via the same BYOK credential resolver — and so the sampling
logic is unit-testable with a fake model and no real frames.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

log = logging.getLogger("woidmod.vision")

# A frame handed to the VLM. Kept opaque here — LiveKit's VideoFrame, a JPEG, a numpy
# array; whatever the caller's track yields. Only `vlm_fn` needs to understand it.
Frame = object
VlmFn = Callable[[Frame, str], Awaitable[str]]  # (frame, instruction) -> scene text
SceneSink = Callable[[str], None]  # emits a scene description into the agent context


@dataclass
class SamplingPolicy:
    """Adaptive frame-rate policy. Pure, deterministic, testable."""

    idle_fps: float = 1.0
    burst_fps: float = 5.0
    # How long a burst lasts after it's requested (seconds).
    burst_window_s: float = 4.0

    def interval_s(self, now: float, burst_until: float) -> float:
        """Seconds to wait before the next sample, given whether we're in a burst."""
        fps = self.burst_fps if now < burst_until else self.idle_fps
        return 1.0 / fps if fps > 0 else float("inf")

    def should_sample(self, now: float, last_sample_at: float, burst_until: float) -> bool:
        """True when enough time has elapsed for the current rate."""
        return (now - last_sample_at) >= self.interval_s(now, burst_until)


class VisionProcessor:
    """Samples frames adaptively, runs the VLM off the hot path, and pushes scene
    descriptions into the conversation. Start it with `run(frame_source)`."""

    def __init__(
        self,
        vlm_fn: VlmFn,
        scene_sink: SceneSink,
        *,
        default_instruction: str = "Briefly describe what the caller is showing.",
        policy: Optional[SamplingPolicy] = None,
        clock: Callable[[], float] = None,  # injectable for tests
    ) -> None:
        self._vlm = vlm_fn
        self._sink = scene_sink
        self._default_instruction = default_instruction
        self._policy = policy or SamplingPolicy()
        self._clock = clock or (lambda: asyncio.get_event_loop().time())
        self._last_sample_at = -1e9
        self._burst_until = -1e9
        self._instruction = default_instruction
        self._pending = False
        # The most recent scene description, read by the agent each turn so the LLM
        # can actually USE what it sees. Empty until the first frame is sampled.
        self.latest_scene: str = ""

    def request_look(self, instruction: Optional[str] = None) -> None:
        """A `vision` flow node (or a "look at this") asks the agent to attend NOW —
        opens a burst window and sets what to look for."""
        now = self._clock()
        self._burst_until = now + self._policy.burst_window_s
        self._instruction = instruction or self._default_instruction
        self._pending = True
        log.debug("vision burst requested until %.2f: %s", self._burst_until, self._instruction)

    def _due(self, now: float) -> bool:
        # A pending explicit request samples immediately; otherwise honour the rate.
        if self._pending:
            return True
        return self._policy.should_sample(now, self._last_sample_at, self._burst_until)

    async def on_frame(self, frame: Frame) -> Optional[str]:
        """Consider one frame. Returns the scene text if this frame was sampled, else
        None. Never raises — a VLM error degrades vision, it does not fail the call."""
        now = self._clock()
        if not self._due(now):
            return None
        self._last_sample_at = now
        self._pending = False
        try:
            scene = await self._vlm(frame, self._instruction)
        except Exception as exc:  # noqa: BLE001 - vision is best-effort
            log.warning("VLM error, skipping frame: %s", exc)
            return None
        if scene and scene.strip():
            # Out-of-band: the voice loop reads this as context, it does not wait for it.
            self.latest_scene = scene.strip()
            self._sink(f"[Vision: {scene.strip()}]")
            return scene.strip()
        return None

    async def run(self, frames) -> None:
        """Drive from an async iterable of frames (a LiveKit video track). Cancels
        cleanly when the track ends or the task is cancelled."""
        async for frame in frames:
            await self.on_frame(frame)


# ---------------------------------------------------------------------------
# BYOK vision model — build a `vlm_fn` from the workspace's own resolved credential.
# ---------------------------------------------------------------------------

def _frame_to_jpeg_b64(frame: Frame) -> str:
    """Encode a frame to base64 JPEG. Handles raw JPEG bytes, an object exposing
    `to_jpeg_bytes()`, or a LiveKit `rtc.VideoFrame` (converted RGBA → JPEG via PyAV).
    Raises if it can't — VisionProcessor.on_frame swallows that and degrades."""
    import base64

    if isinstance(frame, (bytes, bytearray)):
        return base64.b64encode(bytes(frame)).decode("ascii")
    if hasattr(frame, "to_jpeg_bytes"):
        return base64.b64encode(frame.to_jpeg_bytes()).decode("ascii")  # type: ignore[attr-defined]

    # LiveKit VideoFrame: convert to RGBA, then JPEG-encode with PyAV.
    if hasattr(frame, "convert") and hasattr(frame, "width") and hasattr(frame, "height"):
        import numpy as np
        import av
        import livekit.rtc as rtc

        rgba = frame.convert(rtc.VideoBufferType.RGBA)  # type: ignore[attr-defined]
        h, w = frame.height, frame.width  # type: ignore[attr-defined]
        arr = np.frombuffer(bytes(rgba.data), dtype=np.uint8).reshape((h, w, 4))[:, :, :3]
        vframe = av.VideoFrame.from_ndarray(arr, format="rgb24").reformat(format="yuvj420p")
        codec = av.CodecContext.create("mjpeg", "w")
        codec.width, codec.height, codec.pix_fmt = w, h, "yuvj420p"
        packets = codec.encode(vframe) + codec.encode(None)
        if not packets:
            raise ValueError("mjpeg produced no packet")
        return base64.b64encode(bytes(packets[0])).decode("ascii")

    if hasattr(frame, "data"):
        return base64.b64encode(bytes(frame.data)).decode("ascii")  # type: ignore[attr-defined]
    raise TypeError(f"cannot encode frame of type {type(frame).__name__}")


def build_vlm(provider: str, model: str, api_key: str) -> VlmFn:
    """Return a `vlm_fn` that sends one frame + instruction to a BYOK vision model.

    Provider-aware request shapes (all support image input on their messages API):
      - anthropic: /v1/messages with an `image` content block (base64 source)
      - openai / groq: /v1/chat/completions with an `image_url` data: URI
      - gemini: :generateContent with an `inline_data` part

    The model is the customer's own — same key the LLM stage resolves via BYOK. Never
    raises out of the returned fn: a vision error degrades to no scene, not a dropped
    call (VisionProcessor.on_frame already swallows exceptions, but we belt-and-brace)."""
    import aiohttp

    async def anthropic_vlm(frame: Frame, instruction: str) -> str:
        img = _frame_to_jpeg_b64(frame)
        payload = {
            "model": model,
            "max_tokens": 256,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img}},
                    {"type": "text", "text": instruction},
                ],
            }],
        }
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
        async with aiohttp.ClientSession() as s:
            async with s.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers,
                              timeout=aiohttp.ClientTimeout(total=8)) as r:
                body = await r.json()
                return "".join(b.get("text", "") for b in body.get("content", []))

    async def openai_vlm(frame: Frame, instruction: str) -> str:
        img = _frame_to_jpeg_b64(frame)
        base = "https://api.groq.com/openai" if provider == "groq" else "https://api.openai.com"
        payload = {
            "model": model,
            "max_tokens": 256,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": instruction},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img}"}},
                ],
            }],
        }
        headers = {"authorization": f"Bearer {api_key}", "content-type": "application/json"}
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{base}/v1/chat/completions", json=payload, headers=headers,
                              timeout=aiohttp.ClientTimeout(total=8)) as r:
                body = await r.json()
                return body.get("choices", [{}])[0].get("message", {}).get("content", "") or ""

    async def gemini_vlm(frame: Frame, instruction: str) -> str:
        img = _frame_to_jpeg_b64(frame)
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload = {"contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": img}},
            {"text": instruction},
        ]}]}
        async with aiohttp.ClientSession() as s:
            async with s.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=8)) as r:
                body = await r.json()
                cands = body.get("candidates", [{}])
                parts = cands[0].get("content", {}).get("parts", [{}]) if cands else [{}]
                return "".join(p.get("text", "") for p in parts)

    if provider.startswith("anthropic"):
        return anthropic_vlm
    if provider.startswith("gemini") or provider.startswith("vertex"):
        return gemini_vlm
    return openai_vlm  # openai, groq, azure-openai — all OpenAI-shaped
