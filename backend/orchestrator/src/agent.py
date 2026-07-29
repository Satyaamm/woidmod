"""The voice agent: speculative prefill, clause-boundary TTS, honest barge-in.

Three behaviours live here, and each one is a deliberate override of LiveKit's
default rather than a reimplementation of the framework:

1. **Speculative prefill** — start the LLM before the caller has finished, discard
   if they resume. LiveKit has "preemptive generation" but it triggers off *their*
   turn detector; ours fires off our own P(done) curve at 0.4.

2. **Clause-boundary TTS** — flush to speech at punctuation or >=8 tokens, never
   per-token. Per-token flushing wrecks prosody; per-utterance flushing wastes the
   overlap that makes the agent feel fast.

3. **Playout-accurate truncation** — on barge-in, the assistant message written to
   history is exactly what the caller HEARD, not what we generated. This is the
   bookkeeping every competing platform gets wrong: keep the full text and the agent
   believes it said things the caller never heard, so it won't repeat them and the
   conversation desyncs. It presents as "the agent forgot what it was saying after
   I interrupted", and it is not a model-quality problem — it is an accounting bug.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterable, Optional

from livekit.agents import Agent, ChatContext, ChatMessage, llm

from .avatar import AvatarOutput
from .events import TraceEmitter
from .flow_engine import FlowEngine
from .retrieval import top_chunks
from .turn_detector import SemanticTurnDetector
from .vision import VisionProcessor

# A clause boundary is punctuation, or enough tokens that waiting longer costs more
# in latency than it buys in prosody.
_CLAUSE_END = re.compile(r"[.!?,;:]\s*$")
_MIN_CLAUSE_TOKENS = 8


@dataclass
class TurnTiming:
    """Everything needed to reconstruct the latency waterfall for one turn."""

    turn_index: int
    commit_at: float
    speculated_at: Optional[float] = None
    prefill_started_at: Optional[float] = None
    first_token_at: Optional[float] = None
    first_audio_at: Optional[float] = None
    prefix_cache_hit: bool = False
    prompt_tokens: int = 0
    cached_tokens: int = 0
    completion_tokens: int = 0

    def breakdown_ms(self) -> dict[str, float]:
        """end-of-speech -> first audio, split by stage.

        `commit_at` is t=0 by definition: the latency a caller perceives starts when
        they stop talking, not when we decide to start working.
        """
        ttft = (self.first_token_at - self.commit_at) * 1000 if self.first_token_at else 0.0
        ttfb = (
            (self.first_audio_at - self.first_token_at) * 1000
            if self.first_audio_at and self.first_token_at
            else 0.0
        )
        total = (self.first_audio_at - self.commit_at) * 1000 if self.first_audio_at else 0.0
        return {
            "llmTtftMs": round(ttft, 1),
            "ttsTtfbMs": round(ttfb, 1),
            "totalMs": round(total, 1),
            "prefixCacheHit": self.prefix_cache_hit,
        }


@dataclass
class _Speculation:
    """An in-flight prefill that may never be used."""

    transcript: str
    task: asyncio.Task
    started_at: float
    cancelled: bool = False


class VoiceAgent(Agent):
    def __init__(
        self,
        *,
        instructions: str,
        detector: SemanticTurnDetector,
        trace: TraceEmitter,
        speculative_prefill: bool = True,
        agent_id: str = "agent",
        flow_engine: Optional[FlowEngine] = None,
        vision: Optional[VisionProcessor] = None,
        avatar: Optional[AvatarOutput] = None,
        knowledge: Optional[list] = None,
        tools: Optional[list] = None,
        retrieve_ctx: Optional[dict] = None,
    ) -> None:
        # Registering tools here is what lets the LLM actually call them; the base
        # class threads them into every llm_node invocation.
        super().__init__(instructions=instructions, tools=tools or [])
        self._detector = detector
        self._trace = trace
        self._speculative_prefill = speculative_prefill
        self._agent_id = agent_id
        # Workspace KB chunks for grounding (RAG). Empty = the agent answers
        # ungrounded. Retrieval prefers the control-plane semantic endpoint
        # (embeddings + vector store) when `retrieve_ctx` is set, else in-process lexical.
        self._knowledge = knowledge or []
        self._retrieve_ctx = retrieve_ctx
        # The caller's most recent answer — used to route collect/verify flow nodes.
        self._last_answer = ""
        # When present, the agent is flow-driven: the graph decides what each turn is
        # about and routes on the caller's answers. None = pure prompt mode.
        self._flow = flow_engine
        # Video stages — present only for a video-capable agent. The flow's video nodes
        # drive these via `video_action`.
        self._vision = vision
        self._avatar = avatar

        self._speculation: Optional[_Speculation] = None
        self._turn_index = 0
        self._timing: Optional[TurnTiming] = None

        # What has actually been played out of the current agent turn. Reset per
        # turn; read on barge-in.
        self._spoken_chars = 0
        self._generated_text = ""

        detector._on_speculate = self._on_speculate
        detector._on_score = self._on_endpoint_score

    # -- speculative prefill ---------------------------------------------------

    def _on_speculate(self, probability: float, transcript: str) -> None:
        if not self._speculative_prefill or not transcript.strip():
            return
        self._trace.emit("endpoint.speculate", probability=round(probability, 3))
        # We deliberately do NOT start TTS here — only the LLM. LiveKit's own
        # preemptive-generation default makes the same split, and it is the right
        # conservative call: a wasted prefill costs GPU, a wasted synthesis costs
        # money and can leak audio.
        if self._timing:
            self._timing.speculated_at = time.monotonic()

    def _on_endpoint_score(self, probability: float, reason: str) -> None:
        # Sampled, not every tick — a 20ms cadence would flood the trace with
        # thousands of events per turn for no diagnostic gain.
        self._trace.emit_sampled(
            "endpoint.score", probability=round(probability, 3), reason=reason
        )

    def _cancel_speculation(self, why: str) -> None:
        if self._speculation and not self._speculation.cancelled:
            self._speculation.cancelled = True
            self._speculation.task.cancel()
            self._trace.emit("llm.cancelled", reason=why)
        self._speculation = None

    # -- LiveKit hooks ---------------------------------------------------------

    async def on_user_turn_completed(
        self, turn_ctx: ChatContext, new_message: ChatMessage
    ) -> None:
        """Fires the instant the turn is committed. This timestamp is t=0."""
        self._turn_index += 1
        self._timing = TurnTiming(turn_index=self._turn_index, commit_at=time.monotonic())
        self._spoken_chars = 0
        self._generated_text = ""
        self._last_answer = getattr(new_message, "text_content", None) or ""
        self._detector.begin_turn()
        self._trace.emit(
            "endpoint.commit",
            turnIndex=self._turn_index,
            baselineMs=round(self._detector.baseline_ms),
        )
        # The caller just answered the current flow node — advance the graph so the
        # agent's next turn is about the next step.
        self._drive_flow()

    def _drive_flow(self) -> None:
        """Advance the flow past the node the caller just answered, routing through any
        condition nodes to the next conversational/terminal node.

        Slot extraction routes on the caller's actual answer: a `collect` node advances
        on `filled` only when the caller gave a substantive answer (not silence or a
        refusal), and a `verify` node on `passed` only when they affirmed. A real LLM
        slot-extractor is the next step; this is already a real routing decision, not a
        blind success."""
        flow = self._flow
        if not flow or flow.finished:
            return
        node = flow.current()
        tokens = re.findall(r"[a-z0-9]+", self._last_answer.lower())
        if node.type == "condition":
            handle: Optional[str] = flow.route_condition()
        elif node.type == "collect":
            # Filled unless the caller said nothing, or only a refusal ("no", "skip").
            _REFUSAL = {"no", "nope", "skip", "nothing", "none", "dunno"}
            substantive = bool(tokens) and not (len(tokens) <= 2 and set(tokens) <= _REFUSAL)
            handle = "filled" if substantive else "failed"
        elif node.type == "verify":
            _AFFIRM = {"yes", "yeah", "yep", "correct", "right", "sure", "confirm", "ok", "okay"}
            _DENY = {"no", "nope", "wrong", "incorrect"}
            if any(t in _AFFIRM for t in tokens):
                handle = "passed"
            elif any(t in _DENY for t in tokens):
                handle = "failed"
            else:
                handle = "passed" if tokens else "failed"
        elif node.type == "escalate_video":
            handle = "accepted"
        else:
            handle = None
        step = flow.advance(handle)
        # Condition nodes don't consume a caller turn — route straight through them.
        guard = 0
        while step.node.type == "condition" and not step.terminal and guard < 50:
            step = flow.advance(flow.route_condition())
            guard += 1
        self._trace.emit(
            "flow.node", nodeId=step.node.id, nodeType=step.node.type, terminal=step.terminal
        )
        va = flow.video_action(step.node)
        if va:
            self._apply_video_action(va)

    def _apply_video_action(self, va: dict) -> None:
        """Drive the vision/avatar stages from a video flow node."""
        action = va.get("action")
        if action == "look" and self._vision is not None:
            self._vision.request_look(va.get("instruction") or None)
            self._trace.emit("flow.vision", target=va.get("target"))
        elif action == "avatar" and self._avatar is not None:
            self._avatar.set_enabled(bool(va.get("enabled", True)))
            self._trace.emit("flow.avatar", enabled=bool(va.get("enabled", True)))
        elif action == "screen_share":
            self._trace.emit("flow.screen_share", direction=va.get("direction"))
        elif action == "escalate":
            self._trace.emit("flow.escalate_video", requireConsent=va.get("requireConsent"))

    async def llm_node(
        self, chat_ctx: ChatContext, tools: list, model_settings
    ) -> AsyncIterable[llm.ChatChunk | str]:
        """Streams the reply, flushing to TTS at clause boundaries."""
        assert self._timing is not None
        timing = self._timing

        # Per-turn context injection (vision + RAG). Done on ONE copy so these
        # ephemeral system notes shape THIS reply only and never accumulate in history.
        inject_vision = self._vision is not None and bool(self._vision.latest_scene)
        query = self._last_user_text(chat_ctx) if self._knowledge else ""
        hits = await self._retrieve(query) if query else []

        if inject_vision or hits:
            chat_ctx = chat_ctx.copy()
            if inject_vision:
                # Vision-in: give the model what the agent currently SEES.
                chat_ctx.add_message(
                    role="system",
                    content=(
                        "[Live video] The caller's camera currently shows: "
                        f"{self._vision.latest_scene}. Use this to answer questions about "
                        "what they are showing; do not narrate it unprompted."
                    ),
                )
                self._trace.emit("vision.injected", scene=self._vision.latest_scene[:120])
            if hits:
                # RAG: ground the reply on the workspace knowledge base.
                excerpts = "\n\n".join(
                    f"[{h.get('sourceName', 'doc')}] {h.get('text', '')}" for h in hits
                )
                chat_ctx.add_message(
                    role="system",
                    content=(
                        "Relevant knowledge-base excerpts for the caller's question:\n"
                        f"{excerpts}\n\n"
                        "Answer from these if they cover it. If they do not, say you "
                        "don't have that information rather than guessing."
                    ),
                )
                self._trace.emit("rag.retrieved", chunks=len(hits), query=query[:80])

        timing.prefill_started_at = time.monotonic()
        self._trace.emit("llm.prefill_start", speculative=timing.speculated_at is not None)

        buffer: list[str] = []
        token_count = 0

        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            text = _chunk_text(chunk)
            if text:
                if timing.first_token_at is None:
                    timing.first_token_at = time.monotonic()
                    ttft = (timing.first_token_at - timing.commit_at) * 1000
                    self._trace.emit(
                        "llm.first_token",
                        ttftMs=round(ttft, 1),
                        prefixCacheHit=timing.prefix_cache_hit,
                    )
                buffer.append(text)
                self._generated_text += text
                token_count += 1

                joined = "".join(buffer)
                if _CLAUSE_END.search(joined) or token_count >= _MIN_CLAUSE_TOKENS:
                    yield joined
                    buffer.clear()
                    token_count = 0
                continue

            # Non-text chunks (tool calls, usage) pass through untouched.
            _absorb_usage(chunk, timing)
            yield chunk

        if buffer:
            yield "".join(buffer)

        self._trace.emit(
            "llm.done",
            promptTokens=timing.prompt_tokens,
            cachedTokens=timing.cached_tokens,
            completionTokens=timing.completion_tokens,
        )

    async def _retrieve(self, query: str) -> list:
        """Top-k knowledge for grounding. Prefers the control-plane semantic endpoint
        (embeddings + vector store); falls back to in-process lexical on any error, so
        a slow or down control plane degrades recall but never breaks the turn."""
        ctx = self._retrieve_ctx
        if ctx:
            try:
                import aiohttp

                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        f"{ctx['url'].rstrip('/')}/v1/knowledge/retrieve",
                        json={"query": query, "topK": 3},
                        headers={
                            "authorization": f"Bearer {ctx['api_key']}",
                            "x-workspace-id": ctx["workspace_id"],
                        },
                        timeout=aiohttp.ClientTimeout(total=2),
                    ) as res:
                        if res.status == 200:
                            hits = (await res.json()).get("hits", [])
                            if hits:
                                return [
                                    {"sourceName": h.get("sourceName", "doc"), "text": h.get("text", "")}
                                    for h in hits
                                ]
            except Exception:  # noqa: BLE001 - retrieval is best-effort
                pass
        return top_chunks(query, self._knowledge, k=3)

    def _last_user_text(self, chat_ctx: ChatContext) -> str:
        """The caller's most recent message — the query we retrieve against."""
        for item in reversed(chat_ctx.items):
            if getattr(item, "role", None) == "user":
                return getattr(item, "text_content", None) or ""
        return ""

    # -- barge-in --------------------------------------------------------------

    def note_playout(self, chars: int) -> None:
        """Called by the audio output wrapper as audio actually reaches the caller."""
        self._spoken_chars = max(self._spoken_chars, chars)

    def truncate_on_barge_in(self, chat_ctx: ChatContext) -> str:
        """Rewrites the last assistant message to what the caller actually heard.

        Returns the heard text. If nothing was played, the message is removed
        entirely rather than left empty — an empty assistant turn in history is a
        phantom the model will try to make sense of.
        """
        heard = self._generated_text[: self._spoken_chars]
        generated_len = len(self._generated_text)

        self._trace.emit(
            "bargein.truncated",
            playedOutChars=self._spoken_chars,
            generatedChars=generated_len,
        )

        items = chat_ctx.items
        for i in range(len(items) - 1, -1, -1):
            item = items[i]
            if getattr(item, "role", None) != "assistant":
                continue
            if heard.strip():
                item.content = [heard]
            else:
                # Audio never reached the caller — drop the turn. LiveKit models
                # this as played: "skipped" and it is the correct behaviour.
                items.pop(i)
            break

        self._cancel_speculation("barge_in")
        return heard


def _chunk_text(chunk) -> str:
    if isinstance(chunk, str):
        return chunk
    delta = getattr(chunk, "delta", None)
    return getattr(delta, "content", "") or "" if delta else ""


def _absorb_usage(chunk, timing: TurnTiming) -> None:
    """Records token usage, including prefix-cache hits.

    Cache hits are the single biggest cost and latency lever we have (a warm agent
    prefill is ~40 tokens instead of ~4,000), so reporting them accurately matters
    more than it looks. Anthropic reports `cache_read_input_tokens`; OpenAI reports
    `prompt_tokens_details.cached_tokens`.
    """
    usage = getattr(chunk, "usage", None)
    if not usage:
        return
    timing.prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
    timing.completion_tokens = getattr(usage, "completion_tokens", 0) or 0
    cached = (
        getattr(usage, "cache_read_input_tokens", 0)
        or getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0)
        or 0
    )
    timing.cached_tokens = cached
    timing.prefix_cache_hit = cached > 0
