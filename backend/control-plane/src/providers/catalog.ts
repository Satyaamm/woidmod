/**
 * The BYOK provider catalog — what a customer *could* configure, and the EXACT fields
 * each vendor's auth actually requires.
 *
 * This is deliberately independent of which providers are REGISTERED at runtime: a
 * provider only registers once a key exists, but the whole point of BYOK is that the
 * customer adds the key first. The dashboard renders a credential form straight from
 * this, so every field here has to match the vendor's real auth — verified against the
 * adapters in `providers/adapters/*`, which were themselves built from vendor docs.
 *
 * `configFields` = non-secret routing (region, resource, deployment, project) shown as
 * plain inputs. `secretFields` = credentials, rendered as password inputs and encrypted
 * per tenant. A few vendors are NOT a single API key:
 *   - AWS Bedrock: IAM access key id + secret + region (SigV4), not an api key.
 *   - Google Vertex / Google STT+TTS: a service-account JSON key + project + location.
 *   - Azure OpenAI: your own resource + deployment + api-version, plus the key.
 *   - PlayHT: api key AND user id.
 */

export interface ProviderCatalogEntry {
  key: string;
  kind: 'stt' | 'llm' | 'tts';
  label: string;
  /** Non-secret routing fields (region, resource, deployment, project, location). */
  configFields: string[];
  /** Credential fields — rendered as password inputs, encrypted at rest. */
  secretFields: string[];
  /** One-line hint shown under the form, e.g. where to get the key. */
  note?: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // -- STT -------------------------------------------------------------------
  { key: 'deepgram-stt', kind: 'stt', label: 'Deepgram', configFields: [], secretFields: ['apiKey'] },
  { key: 'assemblyai-stt', kind: 'stt', label: 'AssemblyAI', configFields: [], secretFields: ['apiKey'] },
  {
    key: 'azure-speech-stt',
    kind: 'stt',
    label: 'Azure Speech',
    configFields: ['region'],
    secretFields: ['apiKey'],
    note: 'Region is your Speech resource region, e.g. westeurope.',
  },
  { key: 'speechmatics-stt', kind: 'stt', label: 'Speechmatics', configFields: [], secretFields: ['apiKey'] },
  { key: 'soniox-stt', kind: 'stt', label: 'Soniox', configFields: [], secretFields: ['apiKey'] },
  {
    key: 'google-stt',
    kind: 'stt',
    label: 'Google Speech-to-Text',
    configFields: ['projectId'],
    secretFields: ['serviceAccount'],
    note: 'Paste the full service-account JSON key. Residency follows the project.',
  },

  // -- LLM -------------------------------------------------------------------
  { key: 'anthropic-llm', kind: 'llm', label: 'Anthropic', configFields: [], secretFields: ['apiKey'] },
  {
    key: 'openai-llm',
    kind: 'llm',
    label: 'OpenAI',
    // baseUrl lets an OpenAI-compatible gateway (LiteLLM, OpenRouter) be pointed at.
    configFields: ['baseUrl', 'organization'],
    secretFields: ['apiKey'],
  },
  { key: 'gemini-llm', kind: 'llm', label: 'Google Gemini (AI Studio)', configFields: [], secretFields: ['apiKey'] },
  { key: 'groq-llm', kind: 'llm', label: 'Groq', configFields: [], secretFields: ['apiKey'] },
  {
    key: 'azure-openai-llm',
    kind: 'llm',
    label: 'Azure OpenAI',
    // Endpoint is https://{resourceName}.openai.azure.com; deployment is the model.
    configFields: ['resourceName', 'deploymentName', 'apiVersion'],
    secretFields: ['apiKey'],
    note: 'Your own Azure OpenAI resource + deployment. Residency follows the resource region.',
  },
  {
    key: 'bedrock-llm',
    kind: 'llm',
    label: 'AWS Bedrock',
    // SigV4 against bedrock-runtime.{region}.amazonaws.com. Region IS the residency.
    configFields: ['region'],
    secretFields: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
    note: 'IAM credentials with bedrock:InvokeModelWithResponseStream. sessionToken is optional (STS).',
  },
  {
    key: 'vertex-llm',
    kind: 'llm',
    label: 'Google Vertex AI',
    configFields: ['projectId', 'location'],
    secretFields: ['serviceAccount'],
    note: 'Paste the service-account JSON key. Location e.g. europe-west1 sets residency.',
  },

  // -- TTS -------------------------------------------------------------------
  { key: 'cartesia-tts', kind: 'tts', label: 'Cartesia', configFields: [], secretFields: ['apiKey'] },
  { key: 'elevenlabs-tts', kind: 'tts', label: 'ElevenLabs', configFields: [], secretFields: ['apiKey'] },
  {
    key: 'azure-tts',
    kind: 'tts',
    label: 'Azure TTS',
    configFields: ['region'],
    secretFields: ['apiKey'],
    note: 'Same Speech resource + region as Azure STT.',
  },
  { key: 'openai-tts', kind: 'tts', label: 'OpenAI TTS', configFields: [], secretFields: ['apiKey'] },
  {
    key: 'google-tts',
    kind: 'tts',
    label: 'Google Text-to-Speech',
    configFields: ['projectId'],
    secretFields: ['serviceAccount'],
    note: 'Service-account JSON key.',
  },
  {
    key: 'playht-tts',
    kind: 'tts',
    label: 'PlayHT',
    configFields: [],
    secretFields: ['apiKey', 'userId'],
    note: 'PlayHT needs both the API key and the User ID from your dashboard.',
  },
  { key: 'rime-tts', kind: 'tts', label: 'Rime', configFields: [], secretFields: ['apiKey'] },
];
