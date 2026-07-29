"""LiveKit agent worker — the process that actually holds a conversation.

Posture (docs/04): **rent transport, own orchestration.** LiveKit gives us WebRTC,
SIP, the worker/dispatch protocol and per-job process isolation — all expensive to
rebuild and hard to beat. We keep the turn loop: endpointing, speculative prefill and
barge-in truncation, plugged in through documented extension points rather than a
fork.

Deliberately NOT used, because they are LiveKit Inference cloud services and would
couple a self-hosted deployment to their cloud:
  - `inference.TurnDetector`     -> our SemanticTurnDetector
  - `inference.AdaptiveInterruptionDetector` -> interruption mode "vad" + our gate
  - `inference.STT/LLM/TTS` model-string shorthands -> direct provider plugins

Run:
    python -m src.main dev        # local, talks to a dev LiveKit server
    python -m src.main start      # production worker
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import AgentSession, AgentServer, JobContext, RoomInputOptions
from livekit.plugins import silero

from .agent import VoiceAgent
from .avatar import AvatarOutput, WaveformAvatar
from .config import AgentConfig, ConfigError, fetch_agent_config
from .providers import build_llm, build_stt, build_tts
from .flow_engine import FlowEngine, FlowSpec
from .tools import build_tools
from .vision import VisionProcessor, build_vlm
from .events import NullTraceEmitter, TraceEmitter
from .playout import PlayoutTrackingAudioOutput
from .turn_detector import SemanticTurnDetector

# The single repo-root .env, shared by every service. main.py is at
# backend/orchestrator/src/main.py, so the repo root is three parents up.
load_dotenv(Path(__file__).resolve().parents[3] / ".env")
log = logging.getLogger("woidmod.orchestrator")

CONTROL_PLANE_URL = os.getenv("CONTROL_PLANE_URL", "http://localhost:3101")

server = AgentServer()


def prewarm(proc: agents.JobProcess) -> None:
    """Loads models once per worker process, not once per call.

    Silero VAD costs ~200ms to load. Doing it per call would put that on the
    caller's first turn, which is exactly where a slow start is most noticeable.
    """
    proc.userdata["vad"] = silero.VAD.load(
        # LiveKit's own turn detector requires >=0.25s here. Ours doesn't — the VAD
        # is only a speech gate for us, and the endpointer makes the real decision,
        # so we can run it tight and let semantics do the work.
        min_silence_duration=0.10,
        min_speech_duration=0.05,
    )


@server.rtc_session(agent_name="woidmod")
async def entrypoint(ctx: JobContext) -> None:
    """One call. Runs in its own process (LiveKit's default job executor)."""
    await ctx.connect()

    try:
        config = await fetch_agent_config(
            control_plane_url=CONTROL_PLANE_URL,
            metadata=ctx.job.metadata,
        )
    except ConfigError as exc:
        # A call that cannot hear or speak should end immediately with a reason,
        # not connect and sit silent while the caller says "hello?" three times.
        log.error("cannot run this call: %s", exc)
        await ctx.room.disconnect()
        return
    log.info(
        "call starting agent=%s language=%s endpointer=%s",
        config.agent_id, config.language, config.endpointing_strategy,
    )

    trace: TraceEmitter
    if config.workspace_id and config.api_key:
        trace = TraceEmitter(
            call_id=ctx.room.name,
            workspace_id=config.workspace_id,
            agent_id=config.agent_id,
            control_plane_url=CONTROL_PLANE_URL,
            api_key=config.api_key,
        )
    else:
        # A local run with no control plane still produces a full trace, just not a
        # persisted one. Better than silently emitting nothing.
        trace = NullTraceEmitter(call_id=ctx.room.name)
    trace.start()

    # Live console: forward every trace batch to the room's data channel so the
    # browser Test console's transcript / latency / state panels update in real time.
    # Best-effort — telemetry must never break a call.
    async def _publish_events(payload: bytes) -> None:
        try:
            await ctx.room.local_participant.publish_data(payload, reliable=True)
        except Exception as exc:  # noqa: BLE001
            log.debug("data-channel publish failed: %s", exc)

    trace.attach_data_channel(_publish_events)

    detector = SemanticTurnDetector(
        strategy=config.endpointing_strategy,
        on_speculate=None,  # wired by VoiceAgent
        on_score=None,
    )

    # Flow-driven agent: if the agent has a compiled graph, the flow decides what each
    # turn is about and its first actionable node shapes the opening line. A malformed
    # graph falls back to pure prompt mode rather than failing the call.
    flow_engine: Optional[FlowEngine] = None
    instructions = config.prompt
    if config.flow:
        try:
            flow_engine = FlowEngine(FlowSpec.from_dict(config.flow), base_prompt=config.prompt)
            opening = flow_engine.begin()
            if opening.instruction:
                instructions = opening.instruction
            log.info(
                "flow-driven agent: %d nodes, opening on %s",
                len(flow_engine.spec.nodes),
                opening.node.type,
            )
        except Exception as exc:  # noqa: BLE001 - never fail a call on a bad graph
            log.warning("flow parse failed, running in prompt mode: %s", exc)
            flow_engine = None

    # Video stages for a video-capable agent. The avatar starts on the tier-1 waveform
    # renderer (always available; a real avatar vendor plugs in behind AvatarRenderer)
    # and is toggled by `avatar` flow nodes. Vision binds to the caller's video track on
    # a live call with the resolved BYOK vision model.
    avatar = None
    vision = None
    if config.modality in ("video", "both"):
        avatar = AvatarOutput(WaveformAvatar(publish_frame=None), enabled=False)
        # Vision reuses the workspace's OWN LLM credential — a vision-capable model
        # (Claude / GPT-4o / Gemini) served by the same BYOK key the LLM stage uses.
        provider = config.llm_provider.replace("-llm", "")
        vision_key = config.secrets.get(f"{provider}.apiKey")
        if vision_key:
            vision = VisionProcessor(
                build_vlm(provider, config.llm_model, vision_key),
                scene_sink=lambda text: trace.emit("vision.scene", text=text[:200]),
            )
            log.info("video-capable agent (modality=%s): avatar + vision (%s) ready", config.modality, provider)
        else:
            log.info("video-capable agent (modality=%s): avatar ready, no vision key resolved", config.modality)

    agent = VoiceAgent(
        instructions=instructions,
        detector=detector,
        trace=trace,
        speculative_prefill=config.speculative_prefill,
        agent_id=config.agent_id,
        flow_engine=flow_engine,
        avatar=avatar,
        vision=vision,
        knowledge=config.knowledge,
        tools=build_tools(config.tools, trace),
        # Lets the agent use the control-plane's semantic retrieval endpoint per turn
        # (embeddings + vector store), falling back to in-process lexical.
        retrieve_ctx=(
            {"url": CONTROL_PLANE_URL, "api_key": config.api_key, "workspace_id": config.workspace_id}
            if config.workspace_id and config.api_key
            else None
        ),
    )

    # Build the pipeline from the agent's SELECTED providers (BYOK), not a hardcoded
    # trio. Keys resolve BYOK-first from the workspace's encrypted credentials,
    # falling back to platform env only where the customer supplied none. An
    # unsupported vendor or a missing key ends the call with a reason, like config.
    log.info(
        "pipeline stt=%s llm=%s tts=%s",
        config.stt_provider, config.llm_provider, config.tts_provider,
    )
    try:
        stt = build_stt(config)
        llm = build_llm(config)
        tts = build_tts(config)
    except ConfigError as exc:
        log.error("cannot run this call: %s", exc)
        await ctx.room.disconnect()
        return

    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=stt,
        llm=llm,
        tts=tts,
        turn_handling={
            "turn_detection": detector,
            "endpointing": {
                # Our detector owns the decision; these are the outer rails. min is
                # low because a complete utterance commits at ~120ms, max is the
                # safety net for an ambiguous one.
                "mode": "dynamic",
                "min_delay": 0.10,
                "max_delay": 2.0,
            },
            "interruption": {
                # "adaptive" is a LiveKit Inference cloud call. VAD mode plus our
                # own gate keeps this self-hostable.
                "mode": "vad",
                "min_duration": 0.12,
                "resume_false_interruption": True,
                "false_interruption_timeout": 2.0,
            },
        },
    )

    # Own the audio output so WE own `playback_position` — everything downstream
    # (context truncation, metrics) keys off that one number, so owning it means
    # owning truncation semantics without touching LiveKit internals.
    playout = PlayoutTrackingAudioOutput(
        session.output.audio,
        on_progress=agent.note_playout,
        on_interrupted=lambda: agent.truncate_on_barge_in(session.history),
        trace=trace,
    )
    session.output.audio = playout

    trace.emit(
        "call.started",
        agentId=config.agent_id,
        agentVersion=config.version,
        workspaceId=config.workspace_id or "local",
        direction="inbound",
        mode=config.mode,
        region=config.region,
        # Whose keys served this call. An operator debugging a provider error needs
        # to know whether it was the customer's key or ours.
        credentialSources=config.secret_sources,
    )

    @session.on("user_input_transcribed")
    def _on_transcript(ev) -> None:
        detector.update_transcript(ev.transcript)
        detector.mark_speech()
        trace.emit(
            "stt.partial" if not ev.is_final else "stt.final",
            text=ev.transcript,
        )

    @session.on("conversation_item_added")
    def _on_item(ev) -> None:
        # The agent's own replies — so the console transcript shows both sides, not
        # just the caller. User items already arrive via user_input_transcribed.
        item = getattr(ev, "item", None)
        if getattr(item, "role", None) == "assistant":
            text = getattr(item, "text_content", None) or ""
            if text:
                trace.emit("llm.text", text=text)

    @session.on("user_interruption_detected")
    def _on_interrupt(_ev) -> None:
        trace.emit("bargein.detected")

    @session.on("agent_false_interruption")
    def _on_false(_ev) -> None:
        # LiveKit paused, then resumed mid-sentence. Recording it is how we tune
        # the barge-in gate against real callers rather than guesses.
        trace.emit("bargein.rejected", reason="false_interruption")

    try:
        await session.start(
            agent=agent,
            room=ctx.room,
            room_input_options=RoomInputOptions(),
        )
        # Video: bind the caller's camera to vision and publish the agent's avatar.
        if vision is not None or avatar is not None:
            await _wire_video_tracks(ctx, vision, avatar, trace)
        await session.generate_reply(instructions=config.greeting_instruction)
    finally:
        trace.emit("call.ended", reason="session_closed")
        await trace.close()


async def _wire_video_tracks(ctx: JobContext, vision, avatar, trace) -> None:
    """The last live-track hop: bind the caller's camera to the VisionProcessor and
    publish the agent's avatar video track. Best-effort — a failure here degrades the
    call to audio-only, it never aborts it."""
    import livekit.rtc as rtc

    room = ctx.room

    # -- Vision: consume the caller's (or a shared-screen) video track --------
    if vision is not None:
        async def _consume(track) -> None:
            stream = rtc.VideoStream(track)
            trace.emit("video.vision_stream_open")
            try:
                async for ev in stream:
                    await vision.on_frame(ev.frame)
            except Exception as exc:  # noqa: BLE001 - vision is best-effort
                log.warning("vision stream ended: %s", exc)
            finally:
                await stream.aclose()

        def _on_sub(track, publication, participant) -> None:
            if getattr(track, "kind", None) == rtc.TrackKind.KIND_VIDEO:
                trace.emit("video.track_subscribed", participant=getattr(participant, "identity", "?"))
                asyncio.create_task(_consume(track))

        room.on("track_subscribed", _on_sub)
        # Pick up any video track already published before we attached the handler.
        try:
            for participant in room.remote_participants.values():
                for pub in participant.track_publications.values():
                    if pub.track and getattr(pub.track, "kind", None) == rtc.TrackKind.KIND_VIDEO:
                        asyncio.create_task(_consume(pub.track))
        except Exception as exc:  # noqa: BLE001
            log.debug("no pre-existing video tracks: %s", exc)

    # -- Avatar: publish the agent's talking-head video track -----------------
    # Only publish when the renderer actually produces frames. The tier-1
    # WaveformAvatar is a no-op today, and publishing a source it never writes to
    # shows the caller a black tile — worse than no tile. So we skip the publish
    # until a real renderer (2D avatar / photoreal tier) is wired; the avatar object
    # and its barge-in bookkeeping stay in place for that renderer to plug into.
    if avatar is not None and getattr(avatar, "renders_frames", False):
        try:
            source = rtc.VideoSource(640, 480)
            track = rtc.LocalVideoTrack.create_video_track("avatar", source)
            avatar.attach_video_source(source)
            await room.local_participant.publish_track(
                track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA)
            )
            trace.emit("video.avatar_published")
            log.info("avatar video track published")
        except Exception as exc:  # noqa: BLE001 - audio call still works without a face
            log.warning("could not publish avatar track: %s", exc)


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    agents.cli.run_app(server)
