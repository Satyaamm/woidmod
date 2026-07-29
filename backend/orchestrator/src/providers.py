"""Build LiveKit STT / LLM / TTS plugins from the agent's SELECTED providers.

BYOK means a workspace may pick any vendor; the worker must honour that choice
rather than a hardcoded trio. Each builder resolves the vendor from the agent's
pipeline (`config.stt_provider` / `llm_provider` / `tts_provider`), asks
`config.secret(...)` for exactly the field the control-plane returned for that
vendor, and lazily imports its plugin so a missing optional package fails only
the calls that need it — never worker startup.

WHAT CHANGED AND WHY
--------------------
Three enterprise vendors — Azure OpenAI, AWS Bedrock and Google Vertex — were
declared in the catalog, collected real credentials, and then raised
`ConfigError` here with "not wired". The reason was never the auth: it was that
the control plane handed the worker a *key* and nothing else. Azure routes on
resource + deployment + api-version, Bedrock on region, Vertex on project +
location. A key with no destination is unusable, so they could not be built.

The runtime handover now carries `providerConfig` alongside `secrets` (see
`api/v1/runtime.ts`), which is what makes every vendor below constructible. The
same mechanism is what lets `openai-llm` point at any OpenAI-compatible gateway
— LiteLLM, OpenRouter, Together, Fireworks, vLLM, Ollama — via `baseUrl`, which
is how a customer brings a model this catalog has never heard of.

Constructor signatures below were taken from the livekit-agents 1.6.6 plugin
sources (the exact version pinned in requirements.txt), not from prose docs —
several differ from the published guides (`azure.STT` takes `language`, not
`languages`; `aws.LLM` takes `api_key`/`api_secret`, not `access_key_id`).

An unsupported vendor raises `ConfigError` with an actionable message instead of
silently running the wrong provider.
"""

from __future__ import annotations

import json
import logging

from .config import AgentConfig, ConfigError

log = logging.getLogger("woidmod.providers")

# openai.TTS accepts a fixed voice set; a Cartesia/ElevenLabs voice id would crash it.
_OPENAI_VOICES = {
    "alloy", "ash", "ballad", "coral", "echo", "fable",
    "onyx", "nova", "sage", "shimmer", "verse",
}

# Rime takes ISO 639-2/T three-letter codes, not the two-letter codes every other
# vendor here uses. Passing "en" is a 400, so map the languages we sell.
_RIME_LANGS = {
    "en": "eng", "de": "ger", "fr": "fra", "es": "spa",
    "it": "ita", "nl": "nld", "pt": "por", "pl": "pol",
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


def _service_account(raw: str, provider: str) -> dict:
    """Parse a Google service-account JSON key stored as a BYOK secret.

    Google's plugins want the key as a dict (`credentials_info`) or a file path.
    We hold it as an encrypted string, so parsing here keeps it off disk entirely
    — a temp file would outlive the call on a crash and defeat the point of
    encrypting it in the first place.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"{provider}: the stored service account is not valid JSON. Paste the whole "
            f"key file, braces included, under Settings -> Providers."
        ) from exc
    if not isinstance(parsed, dict) or "client_email" not in parsed:
        raise ConfigError(
            f"{provider}: that JSON has no \"client_email\" — it looks like an OAuth client "
            f"file rather than a service-account key."
        )
    return parsed


def _short(language: str) -> str:
    """`en-US` -> `en`. Several vendors reject the region suffix."""
    return language.split("-")[0]


# ---------------------------------------------------------------------------
# Speech to text
# ---------------------------------------------------------------------------


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

    if p == "sarvam-stt":
        # Indian languages. Sarvam wants the FULL locale ("hi-IN", "ta-IN"), not the
        # two-letter short form every other vendor here takes — passing "hi" makes it
        # fall back to its default and quietly transcribe the wrong language.
        sarvam = _need("sarvam")
        return sarvam.STT(
            model="saarika:v2.5",
            language=lang if "-" in lang else "en-IN",
            api_key=config.secret("sarvam.apiKey", "SARVAM_API_KEY"),
        )

    if p == "cartesia-stt":
        # One Cartesia account serves both STT and TTS, so the secret is shared
        # with cartesia-tts — a customer adds the key once.
        # ink-2 is English-only and lower latency; ink-whisper covers everything
        # else. Picking by language rather than defaulting avoids a silent
        # English-only agent on a German number.
        cartesia = _need("cartesia")
        return cartesia.STT(
            model="ink-2" if _short(lang) == "en" else "ink-whisper",
            language=_short(lang),
            api_key=config.secret("cartesia.apiKey", "CARTESIA_API_KEY"),
        )

    if p == "azure-speech-stt":
        # The Speech resource — NOT the Azure OpenAI resource. Different key,
        # different endpoint, and confusing the two is the usual first failure.
        azure = _need("azure")
        return azure.STT(
            speech_key=config.secret("azure.speech.apiKey", "AZURE_SPEECH_KEY"),
            speech_region=config.require_cfg(
                "azure-speech-stt", "region", "AZURE_SPEECH_REGION"
            ),
            # Singular `language` in 1.6.6, despite the guide showing `languages`.
            language=lang,
        )

    if p == "speechmatics-stt":
        speechmatics = _need("speechmatics")
        return speechmatics.STT(
            api_key=config.secret("speechmatics.apiKey", "SPEECHMATICS_API_KEY"),
            # Two-letter code only; "en-US" is rejected.
            language=_short(lang),
        )

    if p == "soniox-stt":
        soniox = _need("soniox")
        return soniox.STT(api_key=config.secret("soniox.apiKey", "SONIOX_API_KEY"))

    if p == "google-stt":
        google = _need("google")
        return google.STT(
            languages=lang,
            credentials_info=_service_account(
                config.secret("google.serviceAccount", "GOOGLE_SERVICE_ACCOUNT"), "google-stt"
            ),
        )

    raise ConfigError(_unsupported("STT", p, _STT_SUPPORTED))


# ---------------------------------------------------------------------------
# Language models
# ---------------------------------------------------------------------------


def build_llm(config: AgentConfig):
    """Language model for the agent's chosen LLM vendor.

    `config.llm_model` is the agent's own model string, set alongside the provider
    in the pipeline — so a workspace picking openai-llm also sets an OpenAI model.
    """
    p = config.llm_provider
    model = config.llm_model

    if p == "anthropic-llm":
        anthropic = _need("anthropic")
        return anthropic.LLM(
            model=model, api_key=config.secret("anthropic.apiKey", "ANTHROPIC_API_KEY")
        )

    if p == "openai-llm":
        # `baseUrl` is the escape hatch that makes this catalog open-ended: any
        # OpenAI-wire-compatible gateway (LiteLLM, OpenRouter, Together,
        # Fireworks, vLLM, Ollama) is reachable through this one branch, so a
        # customer can run a model nobody here has heard of.
        openai = _need("openai")
        base_url = config.cfg("openai-llm", "baseUrl", "OPENAI_BASE_URL")
        kwargs = {
            "model": model,
            "api_key": config.secret("openai.apiKey", "OPENAI_API_KEY"),
        }
        if base_url:
            kwargs["base_url"] = base_url
        return openai.LLM(**kwargs)

    if p == "gemini-llm":
        google = _need("google")
        return google.LLM(model=model, api_key=config.secret("gemini.apiKey", "GEMINI_API_KEY"))

    if p == "groq-llm":
        # Groq is OpenAI-wire-compatible, which is all this needs.
        #
        # This branch previously called `openai.LLM.with_groq(...)`. That helper
        # was removed from livekit-plugins-openai before 1.6.6 (the surviving
        # `with_*` set is cerebras/sambanova/fireworks/x_ai/openrouter/deepseek/
        # cometapi/octo/ollama/ovhcloud/perplexity/together/telnyx/nebius/letta),
        # so every Groq call raised AttributeError at build time — the provider
        # was advertised and unusable. Pointing the base client at Groq's
        # OpenAI-compatible endpoint is exactly what the old helper did.
        # https://console.groq.com/docs/openai
        openai = _need("openai")
        return openai.LLM(
            model=model,
            api_key=config.secret("groq.apiKey", "GROQ_API_KEY"),
            base_url="https://api.groq.com/openai/v1",
        )

    if p == "azure-openai-llm":
        # Azure routes on the DEPLOYMENT name, not the model name. `model` here is
        # documentation for the dashboard; the deployment is what the URL is built
        # from, which is why it is a required config field rather than optional.
        openai = _need("openai")
        resource = config.require_cfg("azure-openai-llm", "resourceName", "AZURE_OPENAI_RESOURCE")
        deployment = config.require_cfg(
            "azure-openai-llm", "deploymentName", "AZURE_OPENAI_DEPLOYMENT"
        )
        api_version = config.cfg(
            "azure-openai-llm", "apiVersion", "AZURE_OPENAI_API_VERSION", "2024-10-21"
        )
        # Customers routinely paste the whole endpoint into "resource name".
        # Accepting both costs three lines and removes a support ticket.
        endpoint = (
            resource
            if resource.startswith("http://") or resource.startswith("https://")
            else f"https://{resource}.openai.azure.com"
        )
        return openai.LLM.with_azure(
            model=model,
            azure_endpoint=endpoint.rstrip("/"),
            azure_deployment=deployment,
            api_version=api_version,
            api_key=config.secret("azure.openai.apiKey", "AZURE_OPENAI_API_KEY"),
        )

    if p == "bedrock-llm":
        # SigV4, not an API key. The plugin names the IAM pair `api_key` /
        # `api_secret`, which reads oddly but is the 1.6.6 signature.
        aws = _need("aws")
        return aws.LLM(
            model=model,
            api_key=config.secret("bedrock.accessKeyId", "AWS_ACCESS_KEY_ID"),
            api_secret=config.secret("bedrock.secretAccessKey", "AWS_SECRET_ACCESS_KEY"),
            region=config.require_cfg("bedrock-llm", "region", "AWS_REGION"),
        )

    if p == "vertex-llm":
        # Vertex is the google plugin in `vertexai=True` mode. It authenticates
        # with a service account rather than an API key, and the plugin wants a
        # google-auth Credentials object — built here from the stored JSON so the
        # key never touches disk.
        google = _need("google")
        try:
            from google.oauth2 import service_account  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise ConfigError(
                "vertex-llm needs the google-auth package, which ships with "
                "livekit-plugins-google. Reinstall the orchestrator requirements."
            ) from exc

        info = _service_account(
            config.secret("vertex.serviceAccount", "VERTEX_SERVICE_ACCOUNT"), "vertex-llm"
        )
        credentials = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        return google.LLM(
            model=model,
            vertexai=True,
            # The service-account key carries its own project; fall back to it so
            # a customer who left the field blank still gets a working agent.
            project=config.cfg("vertex-llm", "projectId", "GOOGLE_CLOUD_PROJECT")
            or info.get("project_id", ""),
            location=config.cfg("vertex-llm", "location", "GOOGLE_CLOUD_LOCATION", "us-central1"),
            credentials=credentials,
        )

    raise ConfigError(_unsupported("LLM", p, _LLM_SUPPORTED))


# ---------------------------------------------------------------------------
# Text to speech
# ---------------------------------------------------------------------------


def build_tts(config: AgentConfig):
    """Text-to-speech for the agent's chosen TTS vendor."""
    p = config.tts_provider
    lang = _short(config.language)
    voice = config.voice_id

    if p == "inworld-tts":
        inworld = _need("inworld")
        return inworld.TTS(
            voice=voice or "Ashley",
            language=config.language,
            api_key=config.secret("inworld.apiKey", "INWORLD_API_KEY"),
        )

    if p == "fishaudio-tts":
        # `reference_id` is the voice; Fish calls it that rather than voice_id, and it
        # is the id of a library or cloned voice, not a name.
        fishaudio = _need("fishaudio")
        return fishaudio.TTS(
            reference_id=voice or None,
            api_key=config.secret("fishaudio.apiKey", "FISH_API_KEY"),
        )

    if p == "sarvam-tts":
        # Same Sarvam account as the STT side — the customer adds one key.
        # `target_language_code` is the full locale and the docs are explicit that it
        # should be set rather than defaulted, so the script matches the text.
        sarvam = _need("sarvam")
        return sarvam.TTS(
            model="bulbul:v2",
            target_language_code=config.language if "-" in config.language else "en-IN",
            speaker=voice or "anushka",
            api_key=config.secret("sarvam.apiKey", "SARVAM_API_KEY"),
        )

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

    if p == "azure-tts":
        # Same Speech resource and key as azure-speech-stt, hence the shared
        # secret namespace. `voice` is an Azure voice name such as
        # `de-DE-KatjaNeural`; the plugin's own default is en-US only.
        azure = _need("azure")
        return azure.TTS(
            speech_key=config.secret("azure.speech.apiKey", "AZURE_SPEECH_KEY"),
            speech_region=config.require_cfg("azure-tts", "region", "AZURE_SPEECH_REGION"),
            **({"voice": voice} if voice else {}),
            language=config.language,
        )

    if p == "google-tts":
        google = _need("google")
        return google.TTS(
            language=config.language,
            **({"voice_name": voice} if voice else {}),
            credentials_info=_service_account(
                config.secret("google.serviceAccount", "GOOGLE_SERVICE_ACCOUNT"), "google-tts"
            ),
        )

    if p == "rime-tts":
        rime = _need("rime")
        return rime.TTS(
            api_key=config.secret("rime.apiKey", "RIME_API_KEY"),
            **({"speaker": voice} if voice else {}),
            # ISO 639-2/T, unlike every other vendor here.
            lang=_RIME_LANGS.get(lang, "eng"),
        )

    if p == "playht-tts":
        # Stored and testable, but not runnable: LiveKit stopped publishing
        # livekit-plugins-playai at 1.2.x and this worker is pinned to 1.6.6.
        # Failing here with the reason beats failing inside the plugin import
        # with an opaque ImportError.
        raise ConfigError(
            "PlayHT cannot run on this worker: LiveKit's playai plugin stopped at 1.2.x and "
            "the worker runs livekit-agents 1.6.6. Your key is stored and valid — pick "
            "Cartesia, ElevenLabs, Azure, Google, OpenAI or Rime for text-to-speech."
        )

    raise ConfigError(_unsupported("TTS", p, _TTS_SUPPORTED))


# ---------------------------------------------------------------------------


_STT_SUPPORTED = [
    "deepgram-stt", "assemblyai-stt", "cartesia-stt",
    "azure-speech-stt", "speechmatics-stt", "soniox-stt", "google-stt", "sarvam-stt",
]
_LLM_SUPPORTED = [
    "anthropic-llm", "openai-llm", "gemini-llm", "groq-llm",
    "azure-openai-llm", "bedrock-llm", "vertex-llm",
]
_TTS_SUPPORTED = [
    "cartesia-tts", "elevenlabs-tts", "openai-tts",
    "azure-tts", "google-tts", "rime-tts", "sarvam-tts",
    "inworld-tts", "fishaudio-tts",
]


def _unsupported(kind: str, provider: str, supported: list[str]) -> str:
    """One message, with the fix in it — an operator should not need the source."""
    return (
        f"{kind} provider '{provider}' is not runnable by this worker. "
        f"Supported: {', '.join(supported)}. "
        f"Change the agent's pipeline under the {kind} field, or add the vendor's "
        f"plugin to requirements.txt and a branch to src/providers.py."
    )


def runnable_providers() -> dict[str, list[str]]:
    """What this worker can actually build. Mirrors the catalog's `runnable` flag."""
    return {"stt": _STT_SUPPORTED, "llm": _LLM_SUPPORTED, "tts": _TTS_SUPPORTED}
