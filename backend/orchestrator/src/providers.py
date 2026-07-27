"""Build LiveKit STT / LLM / TTS plugins from the agent's SELECTED providers.

BYOK means a workspace may pick any vendor; the worker must honour that choice
rather than a hardcoded trio. Each builder resolves the vendor from the agent's
pipeline (`config.stt_provider` / `llm_provider` / `tts_provider`), asks
`config.secret(...)` for exactly the field the control-plane returned for that
vendor (see runtime.ts `SECRET_FIELDS`), and lazily imports its plugin so a
missing optional package fails only the calls that need it — never worker startup.

An unsupported vendor raises `ConfigError` with an actionable message instead of
silently running the wrong provider.
"""

from __future__ import annotations

import logging

from .config import AgentConfig, ConfigError

log = logging.getLogger("woidmod.providers")

# openai.TTS accepts a fixed voice set; a Cartesia/ElevenLabs voice id would crash it.
_OPENAI_VOICES = {
    "alloy", "ash", "ballad", "coral", "echo", "fable",
    "onyx", "nova", "sage", "shimmer", "verse",
}


def _need(plugin: str):
    """Import a livekit plugin, turning a missing package into a clear ConfigError."""
    try:
        module = __import__(f"livekit.plugins.{plugin}", fromlist=[plugin])
        return module
    except ImportError as exc:  # pragma: no cover - depends on install profile
        raise ConfigError(
            f"the '{plugin}' provider plugin is not installed in this worker. "
            f"Add livekit-plugins-{plugin} to requirements.txt and reinstall."
        ) from exc


def build_stt(config: AgentConfig):
    """Speech-to-text for the agent's chosen STT vendor."""
    p = config.stt_provider
    lang = config.language

    if p == "deepgram-stt":
        deepgram = _need("deepgram")
        return deepgram.STT(
            model="nova-3",
            language=lang,
            api_key=config.secret("deepgram.apiKey", "DEEPGRAM_API_KEY"),
        )
    if p == "assemblyai-stt":
        assemblyai = _need("assemblyai")
        return assemblyai.STT(api_key=config.secret("assemblyai.apiKey", "ASSEMBLYAI_API_KEY"))

    raise ConfigError(
        f"STT provider '{p}' is not runnable by this worker yet. "
        f"Supported: deepgram-stt, assemblyai-stt."
    )


def build_llm(config: AgentConfig):
    """Language model for the agent's chosen LLM vendor.

    `config.llm_model` is the agent's own model string, set alongside the provider
    in the pipeline — so a workspace picking openai-llm also sets an OpenAI model.
    """
    p = config.llm_provider
    model = config.llm_model

    if p == "anthropic-llm":
        anthropic = _need("anthropic")
        return anthropic.LLM(model=model, api_key=config.secret("anthropic.apiKey", "ANTHROPIC_API_KEY"))
    if p == "openai-llm":
        openai = _need("openai")
        return openai.LLM(model=model, api_key=config.secret("openai.apiKey", "OPENAI_API_KEY"))
    if p == "gemini-llm":
        google = _need("google")
        return google.LLM(model=model, api_key=config.secret("gemini.apiKey", "GEMINI_API_KEY"))
    if p == "groq-llm":
        # Groq is OpenAI-wire-compatible; the openai plugin ships a Groq constructor.
        openai = _need("openai")
        return openai.LLM.with_groq(model=model, api_key=config.secret("groq.apiKey", "GROQ_API_KEY"))

    raise ConfigError(
        f"LLM provider '{p}' is not runnable by this worker yet. "
        f"Supported: anthropic-llm, openai-llm, gemini-llm, groq-llm. "
        f"(bedrock/vertex/azure use non-apikey auth and need extra config — not wired.)"
    )


def build_tts(config: AgentConfig):
    """Text-to-speech for the agent's chosen TTS vendor."""
    p = config.tts_provider
    lang = config.language.split("-")[0]
    voice = config.voice_id

    if p == "cartesia-tts":
        cartesia = _need("cartesia")
        return cartesia.TTS(
            voice=voice,
            language=lang,
            api_key=config.secret("cartesia.apiKey", "CARTESIA_API_KEY"),
        )
    if p == "elevenlabs-tts":
        elevenlabs = _need("elevenlabs")
        return elevenlabs.TTS(
            voice_id=voice,
            api_key=config.secret("elevenlabs.apiKey", "ELEVENLABS_API_KEY"),
        )
    if p == "openai-tts":
        openai = _need("openai")
        return openai.TTS(
            voice=voice if voice in _OPENAI_VOICES else "alloy",
            api_key=config.secret("openai.apiKey", "OPENAI_API_KEY"),
        )

    raise ConfigError(
        f"TTS provider '{p}' is not runnable by this worker yet. "
        f"Supported: cartesia-tts, elevenlabs-tts, openai-tts."
    )
