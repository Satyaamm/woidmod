/**
 * v1 — runtime credential resolution for the agent worker.
 *
 * ⚠️ This is the ONE endpoint in the platform that returns decrypted secret
 * material. It exists because the worker must call Deepgram/Anthropic/Cartesia
 * directly — proxying provider traffic through the control plane would add a
 * network hop to every single turn, which is precisely the latency tax the whole
 * architecture exists to avoid.
 *
 * The controls that make that acceptable:
 *
 *   1. **Scoped.** Resolution runs through `ProviderCredentialService.resolverFor`,
 *      which only ever reads credentials belonging to the caller's org, and only
 *      those scoped to this workspace or org-wide.
 *   2. **Audited, every time.** Credential access is a `critical`-risk event; a
 *      HIPAA workspace needs a record of every read, not just every write.
 *   3. **Narrow.** Returns only the providers the requested agent's pipeline
 *      actually names. A worker running a Deepgram+Anthropic agent never sees the
 *      workspace's ElevenLabs key.
 *   4. **BYOK first, platform fallback.** A customer's own key is preferred; ours
 *      is used only where they haven't supplied one.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { requirementsFor, checkEligibility } from '../../compliance/provider-eligibility.js';

/** Maps a provider key to the secret fields its adapter asks for. */
const SECRET_FIELDS: Record<string, string[]> = {
  'deepgram-stt': ['deepgram.apiKey'],
  'assemblyai-stt': ['assemblyai.apiKey'],
  'azure-speech-stt': ['azure.speech.key'],
  'speechmatics-stt': ['speechmatics.apiKey'],
  'soniox-stt': ['soniox.apiKey'],
  'anthropic-llm': ['anthropic.apiKey'],
  'openai-llm': ['openai.apiKey'],
  'gemini-llm': ['gemini.apiKey'],
  'groq-llm': ['groq.apiKey'],
  'azure-openai-llm': ['azure.openai.apiKey'],
  // AWS Bedrock is SigV4 — IAM keys, not an API key. sessionToken is optional (STS).
  'bedrock-llm': ['bedrock.accessKeyId', 'bedrock.secretAccessKey'],
  // Google surfaces authenticate with a service-account JSON key.
  'vertex-llm': ['vertex.serviceAccount'],
  'google-stt': ['google.serviceAccount'],
  'google-tts': ['google.serviceAccount'],
  'cartesia-tts': ['cartesia.apiKey'],
  'elevenlabs-tts': ['elevenlabs.apiKey'],
  'azure-tts': ['azure.speech.key'],
  'openai-tts': ['openai.apiKey'],
  'playht-tts': ['playht.apiKey', 'playht.userId'],
  'rime-tts': ['rime.apiKey'],
};

export function runtimeRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  /**
   * Everything the worker needs to run one agent: its pipeline, and the resolved
   * credentials for exactly those providers.
   */
  app.get('/runtime/agents/:id/credentials', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'provider:read');

    const agent = await container.services.agents.get(scope, c.req.param('id'));
    const workspace = await container.services.workspaces.get(scope, scope.workspaceId);

    const wanted = [
      agent.pipeline.sttProvider,
      agent.pipeline.llmProvider,
      agent.pipeline.ttsProvider,
    ];

    // Re-checked HERE, not just at configuration time: a workspace can be switched
    // into HIPAA mode or moved between blocs after an agent was configured, and
    // that must invalidate the agent rather than silently keep routing data.
    const requirements = requirementsFor(workspace.region, workspace.compliance);
    const ineligible = wanted
      .map((key) => ({ key, result: checkEligibility(container.compliance.postures.get(key), requirements) }))
      .filter((x) => !x.result.eligible);

    if (ineligible.length) {
      return c.json(
        {
          error: 'provider_ineligible',
          message:
            'This agent names providers that are not permitted for this workspace. ' +
            'Change the pipeline or the workspace compliance settings.',
          providers: ineligible.map((x) => ({ key: x.key, reasons: x.result.reasons })),
        },
        409,
      );
    }

    const resolver = await container.services.providerCredentials.resolverFor(scope);

    const secrets: Record<string, string> = {};
    const missing: string[] = [];
    const sources: Record<string, 'byok' | 'platform'> = {};

    for (const providerKey of new Set(wanted)) {
      for (const field of SECRET_FIELDS[providerKey] ?? []) {
        try {
          secrets[field] = await resolver.get(field);
          sources[field] = 'byok';
        } catch {
          missing.push(field);
        }
      }
    }

    // Ground the agent on the workspace knowledge base (RAG). Best-effort context —
    // a permission or store hiccup must degrade to an ungrounded call, never fail it.
    let knowledge: Array<{ sourceId: string; sourceName: string; text: string }> = [];
    try {
      knowledge = await container.services.knowledge.corpus(scope);
    } catch {
      knowledge = [];
    }

    await container.compliance.audit.record(scope, 'apikey.used', {
      resourceType: 'provider_credential',
      resourceId: agent.id,
      metadata: {
        agentId: agent.id,
        agentVersion: agent.version,
        providers: [...new Set(wanted)],
        // Field NAMES only — never a value, never a hint. This record outlives the
        // credential it describes.
        resolved: Object.keys(secrets),
        missing,
      },
    });

    return c.json({
      agent: {
        id: agent.id,
        version: agent.version,
        language: agent.language,
        prompt: agent.prompt,
        modality: agent.modality,
        voice: agent.voice,
        pipeline: agent.pipeline,
        tools: agent.tools,
        /** The compiled flow graph the worker executes; absent = pure prompt mode. */
        flow: agent.flow,
        /** Workspace KB chunks for in-process retrieval (RAG); empty = ungrounded. */
        knowledge,
      },
      secrets,
      sources,
      /** Non-empty means the worker cannot run this agent — surfaced, not hidden. */
      missing,
      region: workspace.region,
    });
  });

  return app;
}
