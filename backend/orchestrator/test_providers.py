"""Every BYOK vendor in the catalog can actually be BUILT by this worker.

Why this test exists
--------------------
Three vendors (Azure OpenAI, AWS Bedrock, Google Vertex) shipped in the provider
catalog for months, collected real customer credentials, and then raised
"not wired" at call time. A fourth, Groq, was worse: it called
`openai.LLM.with_groq(...)`, a helper that livekit-plugins-openai removed before
1.6.6, so it raised AttributeError — advertised, accepted, and broken, with the
failure landing on a caller mid-call.

Nothing caught either, because "does this vendor construct?" was only ever
answered by placing a real call with real keys. This test answers it in a second,
with fake ones.

What it asserts
---------------
For every provider key the catalog says is runnable, `build_stt`/`build_llm`/
`build_tts` returns a plugin instance. Credentials are deliberately fake — we are
testing that OUR kwargs match the INSTALLED plugin signatures, which is what
drifts when livekit-agents is bumped. A vendor SDK rejecting a fake key is a
pass; a TypeError or AttributeError is the bug this catches.

Run: .venv/bin/python test_providers.py
"""

from __future__ import annotations

import json
import sys
import traceback

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from src.config import AgentConfig, ConfigError
from src.providers import build_llm, build_stt, build_tts


def _fake_service_account() -> str:
    """A structurally valid service-account key, generated fresh each run.

    Generated rather than committed: a real-looking PEM in the repo trips secret
    scanners and teaches the wrong habit. Google's own parser runs against this,
    so a malformed key would fail the test rather than pass it silently.
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "test-project",
            "private_key_id": "test",
            "private_key": key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode(),
            "client_email": "test@test-project.iam.gserviceaccount.com",
            "client_id": "1",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


FAKE_SA = _fake_service_account()

SECRETS = {
    "deepgram.apiKey": "test",
    "assemblyai.apiKey": "test",
    "cartesia.apiKey": "test",
    "azure.speech.apiKey": "test",
    "speechmatics.apiKey": "test",
    "soniox.apiKey": "test",
    "google.serviceAccount": FAKE_SA,
    "anthropic.apiKey": "test",
    "openai.apiKey": "test",
    "gemini.apiKey": "test",
    "groq.apiKey": "test",
    "azure.openai.apiKey": "test",
    # AWS's own docs placeholder (AKIA + 16 chars) is indistinguishable from a real
    # key id to any scanner, including this repo's CI gate. Nothing here asserts on
    # the format, so the fixture does not need to imitate one.
    "bedrock.accessKeyId": "test-access-key-id",
    "bedrock.secretAccessKey": "test",
    "vertex.serviceAccount": FAKE_SA,
    "elevenlabs.apiKey": "test",
    "rime.apiKey": "test",
}

# The non-secret routing the control plane sends as `providerConfig`. Without it
# Azure/Bedrock/Vertex have a key and no destination — the original bug.
PROVIDER_CONFIG = {
    "azure-speech-stt": {"region": "westeurope"},
    "azure-tts": {"region": "westeurope"},
    "azure-openai-llm": {
        "resourceName": "test-resource",
        "deploymentName": "gpt-4o-mini",
        "apiVersion": "2024-10-21",
    },
    "bedrock-llm": {"region": "eu-central-1"},
    "vertex-llm": {"projectId": "test-project", "location": "europe-west1"},
    "openai-llm": {"baseUrl": "https://gateway.example.com/v1"},
}

RUNNABLE = {
    "stt": (
        build_stt,
        [
            "deepgram-stt", "assemblyai-stt", "cartesia-stt", "azure-speech-stt",
            "speechmatics-stt", "soniox-stt", "google-stt",
        ],
    ),
    "llm": (
        build_llm,
        [
            "anthropic-llm", "openai-llm", "gemini-llm", "groq-llm",
            "azure-openai-llm", "bedrock-llm", "vertex-llm",
        ],
    ),
    "tts": (
        build_tts,
        ["cartesia-tts", "elevenlabs-tts", "openai-tts", "azure-tts", "google-tts", "rime-tts"],
    ),
}


def _config(kind: str, provider: str) -> AgentConfig:
    cfg = AgentConfig(
        agent_id="test",
        prompt="test",
        language="de-DE",
        # A locale other than en-US on purpose: it exercises the language mapping
        # every vendor does differently (Rime wants "ger", Cartesia wants "de",
        # Azure wants "de-DE"), which is where a silently-English agent comes from.
        voice_id="de-DE-KatjaNeural" if provider == "azure-tts" else "test-voice",
        llm_model="gpt-4o-mini",
        secrets=dict(SECRETS),
        provider_config=dict(PROVIDER_CONFIG),
    )
    setattr(cfg, f"{kind}_provider", provider)
    return cfg


def main() -> int:
    failures: list[str] = []

    for kind, (builder, providers) in RUNNABLE.items():
        for provider in providers:
            try:
                built = builder(_config(kind, provider))
                assert built is not None, "builder returned None"
                print(f"  {provider:20s} -> {type(built).__module__}.{type(built).__name__}")
            except (TypeError, AttributeError) as exc:
                # The failure mode this test exists for: our kwargs no longer
                # match the installed plugin. Always a real bug.
                failures.append(f"{provider}: {type(exc).__name__}: {exc}")
                traceback.print_exc()
            except ConfigError as exc:
                failures.append(f"{provider}: ConfigError: {exc}")
            except Exception as exc:
                # A vendor SDK rejecting fake credentials is the expected outcome
                # for anything that validates eagerly. Not a failure.
                print(f"  {provider:20s} -> constructed via {type(exc).__name__} (fake creds)")

    # PlayHT is in the catalog and deliberately NOT runnable: LiveKit stopped
    # publishing livekit-plugins-playai at 1.2.x. It must refuse with a reason,
    # not an ImportError — if a plugin ever ships, this is the line that tells us.
    try:
        build_tts(_config("tts", "playht-tts"))
        failures.append("playht-tts: built unexpectedly — is the plugin back? Update the catalog.")
    except ConfigError as exc:
        assert "playai" in str(exc), f"playht refusal lost its explanation: {exc}"
        print("  playht-tts           -> refused with a reason (expected)")

    # A vendor nobody wired must fail loudly rather than falling back to a default:
    # silently running the wrong provider would route customer audio to a vendor
    # they did not choose, which is a compliance problem, not just a bug.
    try:
        build_llm(_config("llm", "some-unknown-llm"))
        failures.append("unknown provider was accepted instead of refused")
    except ConfigError as exc:
        assert "not runnable" in str(exc), exc
        print("  unknown provider     -> refused with the supported list (expected)")

    # Azure's routing must survive into the client, not just the constructor.
    client = build_llm(_config("llm", "azure-openai-llm"))._client
    expected = "https://test-resource.openai.azure.com/openai/deployments/gpt-4o-mini/"
    if str(client.base_url) != expected:
        failures.append(f"azure endpoint wrong: {client.base_url} != {expected}")
    else:
        print(f"  azure routing        -> {client.base_url}")

    # Pasting the whole endpoint into "resource name" is the commonest Azure
    # mistake; it must normalise rather than produce a double-scheme host.
    cfg = _config("llm", "azure-openai-llm")
    cfg.provider_config["azure-openai-llm"]["resourceName"] = "https://test-resource.openai.azure.com/"
    if str(build_llm(cfg)._client.base_url) != expected:
        failures.append("azure resource name was not normalised when a full URL was pasted")
    else:
        print("  azure full-URL paste -> normalised")

    if failures:
        print("\nFAIL — " + "\n       ".join(failures))
        return 1

    print("\nPASS — every runnable provider builds against the installed livekit plugins.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
