"""Agent configuration and provider credentials, fetched from the control plane.

The worker holds **no agent config and no API keys of its own**. Both come from the
control plane at call start, which is what makes three things true:

  - **BYOK works.** A customer's own Deepgram/Anthropic/Cartesia keys live encrypted
    in the database under their tenant key, and the worker gets whichever key is
    correct for the workspace placing this call. Ours are only a fallback.
  - **Version pinning is real.** Every call records the exact agent version it ran,
    because the worker asks for it rather than caching a copy.
  - **Compliance is enforced at dispatch, not just at save.** The control plane
    re-checks provider eligibility when handing over credentials, so a workspace
    switched into HIPAA mode or moved to an EU region invalidates a stale agent
    instead of silently continuing to route data.

`.env` keys remain supported as a platform-level fallback for a shared trial tier,
but a production deployment should have none set.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Optional

import aiohttp

log = logging.getLogger("woidmod.config")


class ConfigError(RuntimeError):
    """Raised when a call cannot be run — surfaced to the caller, never swallowed."""


@dataclass
class AgentConfig:
    agent_id: str
    prompt: str
    language: str = "en-US"
    voice_id: str = "a0e99841-438c-4a64-b679-ae501e7d6091"
    llm_model: str = "claude-haiku-4-5"
    stt_provider: str = "deepgram-stt"
    llm_provider: str = "anthropic-llm"
    tts_provider: str = "cartesia-tts"
    endpointing_strategy: str = "semantic"
    speculative_prefill: bool = True
    greeting_instruction: str = "Greet the caller warmly in one short sentence."
    workspace_id: Optional[str] = None
    api_key: Optional[str] = None
    mode: str = "test"
    version: int = 1
    region: str = "us-east"
    # Modality + the compiled flow graph the worker executes (None = pure prompt mode).
    modality: str = "voice"
    flow: Optional[dict] = None
    # Workspace knowledge-base chunks for in-process retrieval (RAG). Empty = the
    # agent answers ungrounded. Each item: {sourceId, sourceName, text}.
    knowledge: list = field(default_factory=list)
    # HTTP tools the agent may call: {name, description, endpoint, method, parameters,
    # timeoutMs}. Empty = a talk-only agent. Executed live (see tools.py).
    tools: list = field(default_factory=list)

    # Resolved secrets, keyed as the adapters ask for them ("deepgram.apiKey").
    secrets: dict[str, str] = field(default_factory=dict)
    # Which came from the customer vs. the platform — shown in the trace so an
    # operator can see whose key served a call.
    secret_sources: dict[str, str] = field(default_factory=dict)

    def secret(self, name: str, env_fallback: str) -> str:
        """BYOK first, platform env second, clear failure third."""
        value = self.secrets.get(name) or os.getenv(env_fallback, "")
        if not value:
            raise ConfigError(
                f"no credential for {name}. Add it in the dashboard under "
                f"Settings -> Providers, or set {env_fallback} for a platform key."
            )
        return value


_FALLBACK_PROMPT = (
    "You are a helpful voice assistant. Keep every reply to one or two short "
    "sentences — you are on a phone call, not writing an email. If you do not know "
    "something, say so and offer to connect the caller to a person."
)


async def fetch_agent_config(
    *, control_plane_url: str, metadata: Optional[str]
) -> AgentConfig:
    """Resolves everything needed to run one call.

    Job metadata carries only identifiers, never secrets — a room token is visible
    to the browser, so anything in it is effectively public. The worker exchanges
    those identifiers for config and credentials over an authenticated call.
    """
    meta = _parse_metadata(metadata)
    agent_id = meta.get("agentId")
    workspace_id = meta.get("workspaceId")
    api_key = meta.get("apiKey") or os.getenv("WOIDMOD_API_KEY")

    if not (agent_id and workspace_id and api_key):
        # `python -m src.main dev` with no control plane still produces a talking
        # agent, using platform env keys. Useful for provider debugging.
        log.warning(
            "no control-plane identifiers in job metadata — running the local "
            "fallback agent on platform env keys"
        )
        return AgentConfig(agent_id="local-fallback", prompt=_FALLBACK_PROMPT)

    url = f"{control_plane_url.rstrip('/')}/v1/runtime/agents/{agent_id}/credentials"
    headers = {
        "authorization": f"Bearer {api_key}",
        "x-workspace-id": workspace_id,
        "x-mode": meta.get("mode", "test"),
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url, headers=headers, timeout=aiohttp.ClientTimeout(total=4)
            ) as res:
                body = await res.json()
                if res.status == 409:
                    # Compliance rejected the pipeline. This must be loud: silently
                    # falling back would route data through a provider the workspace
                    # is not permitted to use.
                    raise ConfigError(
                        f"{body.get('message', 'provider not permitted')} "
                        f"({', '.join(p['key'] for p in body.get('providers', []))})"
                    )
                if res.status != 200:
                    raise ConfigError(
                        f"control plane returned {res.status} resolving agent {agent_id}"
                    )
    except ConfigError:
        raise
    except Exception as exc:
        raise ConfigError(f"could not reach the control plane: {exc}") from exc

    agent = body["agent"]
    pipeline = agent.get("pipeline", {})
    voice = agent.get("voice", {})
    missing = body.get("missing", [])

    if missing:
        # Starting a call that cannot hear or speak wastes the caller's time and
        # bills for a connection. Refuse with a message an operator can act on.
        raise ConfigError(
            "missing provider credentials: "
            + ", ".join(missing)
            + ". Add them in the dashboard under Settings -> Providers."
        )

    return AgentConfig(
        agent_id=agent["id"],
        prompt=agent.get("prompt") or _FALLBACK_PROMPT,
        language=agent.get("language", "en-US"),
        voice_id=voice.get("voiceId") or AgentConfig.voice_id,
        llm_model=pipeline.get("llmModel", "claude-haiku-4-5"),
        stt_provider=pipeline.get("sttProvider", "deepgram-stt"),
        llm_provider=pipeline.get("llmProvider", "anthropic-llm"),
        tts_provider=pipeline.get("ttsProvider", "cartesia-tts"),
        endpointing_strategy=pipeline.get("endpointingStrategy", "semantic"),
        speculative_prefill=pipeline.get("speculativePrefill", True),
        workspace_id=workspace_id,
        api_key=api_key,
        mode=meta.get("mode", "test"),
        version=agent.get("version", 1),
        region=body.get("region", "us-east"),
        secrets=body.get("secrets", {}),
        secret_sources=body.get("sources", {}),
        modality=agent.get("modality", "voice"),
        flow=agent.get("flow"),
        knowledge=agent.get("knowledge") or [],
        tools=agent.get("tools") or [],
    )


def _parse_metadata(metadata: Optional[str]) -> dict:
    if not metadata:
        return {}
    try:
        parsed = json.loads(metadata)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        log.warning("job metadata was not JSON")
        return {}
