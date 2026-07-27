"""Real tool execution.

An agent can be configured with HTTP tools — each is
`{name, description, endpoint, method, parameters, timeoutMs}` (see the control-plane
`toolConfigSchema`). This turns each into a LiveKit raw-schema function tool the LLM
can actually call mid-conversation: when the model invokes it, we make the real HTTP
request and hand the response back to the model, so the agent can look up an order,
book a slot, or transfer — not just talk about doing so.

Every call emits `tool.started` / `tool.finished` trace events, so tool activity shows
in the live console and the call trace like every other lane. Failures return a short
message to the model (which can recover gracefully) rather than crashing the turn.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp
from livekit.agents.llm import function_tool

from .events import TraceEmitter

log = logging.getLogger("woidmod.tools")

# Cap the body we feed back to the model — a tool returning a megabyte of JSON would
# blow the context and the latency budget.
_MAX_RESPONSE_CHARS = 2000


def build_tools(tool_configs: list[dict], trace: TraceEmitter) -> list:
    """Build LiveKit function tools from the agent's configured HTTP tools."""
    tools = []
    for tc in tool_configs or []:
        tool = _make_tool(tc, trace)
        if tool is not None:
            tools.append(tool)
    if tools:
        log.info("registered %d tool(s): %s", len(tools), ", ".join(tc.get("name", "?") for tc in tool_configs))
    return tools


def _make_tool(tc: dict, trace: TraceEmitter):
    name = tc.get("name")
    endpoint = tc.get("endpoint")
    if not name or not endpoint:
        return None
    method = (tc.get("method") or "POST").upper()
    timeout_ms = int(tc.get("timeoutMs") or 3000)
    parameters = tc.get("parameters") or {"type": "object", "properties": {}}
    description = tc.get("description") or name

    async def handler(raw_arguments: dict[str, Any]) -> str:
        t0 = time.monotonic()
        trace.emit("tool.started", name=name)
        try:
            timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                if method == "GET":
                    query = {k: str(v) for k, v in raw_arguments.items()}
                    async with session.get(endpoint, params=query) as res:
                        body, status = await res.text(), res.status
                else:
                    async with session.request(method, endpoint, json=raw_arguments) as res:
                        body, status = await res.text(), res.status
            dur = int((time.monotonic() - t0) * 1000)
            ok = status < 400
            trace.emit("tool.finished", name=name, status="ok" if ok else "error", durationMs=dur)
            if not ok:
                return f"Tool '{name}' returned HTTP {status}: {body[:400]}"
            return body[:_MAX_RESPONSE_CHARS]
        except Exception as exc:  # noqa: BLE001 - a tool error must not crash the turn
            dur = int((time.monotonic() - t0) * 1000)
            trace.emit("tool.finished", name=name, status="error", durationMs=dur)
            log.warning("tool %s failed: %s", name, exc)
            return (
                f"The '{name}' tool could not be reached. Tell the caller you were "
                "unable to complete that action right now."
            )

    return function_tool(
        handler,
        raw_schema={"name": name, "description": description, "parameters": parameters},
    )
