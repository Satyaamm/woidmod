"""Pipeline trace events, shipped to the control plane.

The event names and payloads mirror
`backend/control-plane/src/orchestration/events.ts` exactly, so the dashboard's trace
viewer renders a real call and a simulated one with the same code.

Delivery is fire-and-forget over a background queue. Nothing here may block the turn
loop: a slow control plane must never add latency to a phone call, and a control
plane that is entirely down must not drop the call.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Awaitable, Callable, Optional

import aiohttp


class TraceEmitter:
    """Buffers events for one call and flushes them asynchronously."""

    def __init__(
        self,
        *,
        call_id: str,
        workspace_id: str,
        agent_id: str,
        control_plane_url: str,
        api_key: Optional[str] = None,
        sample_interval_ms: float = 100.0,
    ) -> None:
        self.call_id = call_id
        self.workspace_id = workspace_id
        self.agent_id = agent_id
        self._url = control_plane_url.rstrip("/")
        self._api_key = api_key
        self._t0 = time.monotonic()
        self._buffer: list[dict[str, Any]] = []
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=4096)
        self._task: Optional[asyncio.Task] = None
        self._sample_interval = sample_interval_ms / 1000.0
        self._last_sampled: dict[str, float] = {}
        # Optional live sink: publish each batch to the LiveKit data channel so the
        # browser Test console updates in real time (it reads RoomEvent.DataReceived).
        self._data_sink: Optional[Callable[[bytes], Awaitable[None]]] = None

    def attach_data_channel(self, publish: Callable[[bytes], Awaitable[None]]) -> None:
        """Wire a coroutine that ships a JSON batch to the room's data channel."""
        self._data_sink = publish

    def start(self) -> None:
        self._task = asyncio.create_task(self._drain())

    def emit(self, event_type: str, **payload: Any) -> None:
        """Record an event. Never awaits, never raises into the caller."""
        record = {
            "type": event_type,
            "callId": self.call_id,
            # Relative to call start so the dashboard can align every lane on one
            # timeline without server-side clock reconciliation.
            "tMs": round((time.monotonic() - self._t0) * 1000, 1),
            **payload,
        }
        self._buffer.append(record)
        try:
            self._queue.put_nowait(record)
        except asyncio.QueueFull:
            # Dropping trace events is always preferable to stalling audio. The
            # local buffer still has them for the end-of-call flush.
            pass

    def emit_sampled(self, event_type: str, **payload: Any) -> None:
        """Rate-limited emit, for high-frequency signals like the P(done) curve.

        The endpointer scores every ~20ms. Emitting all of it would be ~3,000 events
        per turn — enough to matter for bandwidth and to make the trace viewer's
        downsampler do work it doesn't need to.
        """
        now = time.monotonic()
        last = self._last_sampled.get(event_type, 0.0)
        if now - last < self._sample_interval:
            return
        self._last_sampled[event_type] = now
        self.emit(event_type, **payload)

    async def _drain(self) -> None:
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        headers["x-workspace-id"] = self.workspace_id

        async with aiohttp.ClientSession(headers=headers) as session:
            batch: list[dict[str, Any]] = []
            while True:
                try:
                    # Batch on a short window: enough to avoid a request per event,
                    # short enough that a live trace view stays live.
                    event = await asyncio.wait_for(self._queue.get(), timeout=0.25)
                    batch.append(event)
                except asyncio.TimeoutError:
                    pass
                except asyncio.CancelledError:
                    break

                if batch and (len(batch) >= 32 or self._queue.empty()):
                    await self._flush(session, batch)
                    batch = []

            if batch:
                await self._flush(session, batch)

    async def _flush(self, session: aiohttp.ClientSession, batch: list) -> None:
        """Ship one batch to BOTH sinks: the control plane (persist) and, if wired,
        the data channel (live browser console). Each is independent and best-effort
        so neither a down control plane nor a browser hiccup affects the call."""
        payload = json.dumps({"events": batch})
        await self._post(session, payload)
        if self._data_sink:
            try:
                await self._data_sink(payload.encode())
            except Exception:
                pass

    async def _post(self, session: aiohttp.ClientSession, payload: str) -> None:
        try:
            await session.post(
                f"{self._url}/v1/calls/{self.call_id}/events",
                data=payload,
                timeout=aiohttp.ClientTimeout(total=2),
            )
        except Exception:
            # A control plane that is down must not affect the call in progress.
            # Events are still in `self._buffer` for the final flush attempt.
            pass

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    @property
    def events(self) -> list[dict[str, Any]]:
        """The full local buffer — used by the smoke test and for a final flush."""
        return list(self._buffer)


class NullTraceEmitter(TraceEmitter):
    """No-op emitter for local runs with no control plane. Keeps the buffer."""

    def __init__(self, call_id: str = "local") -> None:
        super().__init__(
            call_id=call_id,
            workspace_id="local",
            agent_id="local",
            control_plane_url="http://localhost:0",
        )

    def start(self) -> None:  # no background task, no network
        return

    async def close(self) -> None:
        return
