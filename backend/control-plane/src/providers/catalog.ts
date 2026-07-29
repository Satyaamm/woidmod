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
  /**
   * Where the customer creates the key. "Bring your own key" is a dead end if
   * finding the key is a scavenger hunt, so the form links straight to the page
   * that issues it — not the vendor's marketing homepage.
   */
  keyUrl?: string;
  /**
   * Config fields that are optional. Everything in `configFields` not listed here
   * is required by the form. Kept as a separate list so the common case (all
   * required) stays a plain array.
   */
  optionalFields?: string[];
  /** Default values pre-filled into the form for fields with a sane default. */
  defaults?: Record<string, string>;
  /**
   * Whether the orchestrator can actually run this vendor on a live call.
   *
   * Every entry here can be STORED — the credential is encrypted per tenant
   * regardless. But a vendor the worker cannot build a plugin for will fail at
   * call time, and a customer deserves to know that while choosing, not then.
   * Kept in the catalog rather than the worker because this endpoint is what the
   * dashboard reads.
   */
  runnable: boolean;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // -- STT -------------------------------------------------------------------
  {
    key: 'deepgram-stt',
    kind: 'stt',
    label: 'Deepgram',
    configFields: [],
    secretFields: ['apiKey'],
    note: 'Nova-3. Lowest latency on English telephony; free credit on signup.',
    keyUrl: 'https://console.deepgram.com/signup',
    runnable: true,
  },
  {
    key: 'assemblyai-stt',
    kind: 'stt',
    label: 'AssemblyAI',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://www.assemblyai.com/dashboard/signup',
    runnable: true,
  },
  {
    key: 'cartesia-stt',
    kind: 'stt',
    label: 'Cartesia (Ink)',
    configFields: [],
    secretFields: ['apiKey'],
    note: 'Same key as Cartesia TTS. Ink-Whisper covers non-English; ink-2 is English-only.',
    keyUrl: 'https://play.cartesia.ai/keys',
    runnable: true,
  },
  {
    key: 'azure-speech-stt',
    kind: 'stt',
    label: 'Azure Speech',
    configFields: ['region'],
    secretFields: ['apiKey'],
    note: 'Region is your Speech resource region, e.g. westeurope. This is the Speech resource, not Azure OpenAI.',
    keyUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    runnable: true,
  },
  {
    key: 'speechmatics-stt',
    kind: 'stt',
    label: 'Speechmatics',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://portal.speechmatics.com/manage-access',
    runnable: true,
  },
  {
    key: 'soniox-stt',
    kind: 'stt',
    label: 'Soniox',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://console.soniox.com',
    runnable: true,
  },
  {
    key: 'google-stt',
    kind: 'stt',
    label: 'Google Speech-to-Text',
    configFields: ['projectId'],
    secretFields: ['serviceAccount'],
    note: 'Paste the full service-account JSON key. Residency follows the project.',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    runnable: true,
  },

  // -- LLM -------------------------------------------------------------------
  {
    key: 'anthropic-llm',
    kind: 'llm',
    label: 'Anthropic',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    runnable: true,
  },
  {
    key: 'openai-llm',
    kind: 'llm',
    label: 'OpenAI (or any OpenAI-compatible gateway)',
    // baseUrl lets an OpenAI-compatible gateway (LiteLLM, OpenRouter, vLLM,
    // Together, Fireworks, Ollama) be pointed at — which is how a customer
    // brings a vendor this catalog has never heard of.
    configFields: ['baseUrl', 'organization'],
    optionalFields: ['baseUrl', 'organization'],
    secretFields: ['apiKey'],
    note:
      'Leave Base URL empty for OpenAI itself. Point it at LiteLLM, OpenRouter, Together, ' +
      'Fireworks, vLLM or Ollama to use any model they expose.',
    keyUrl: 'https://platform.openai.com/api-keys',
    runnable: true,
  },
  {
    key: 'gemini-llm',
    kind: 'llm',
    label: 'Google Gemini (AI Studio)',
    configFields: [],
    secretFields: ['apiKey'],
    note: 'Free tier available — the fastest way to get a working agent.',
    keyUrl: 'https://aistudio.google.com/apikey',
    runnable: true,
  },
  {
    key: 'groq-llm',
    kind: 'llm',
    label: 'Groq',
    configFields: [],
    secretFields: ['apiKey'],
    note: 'Free tier available. Fastest time-to-first-token in the set.',
    keyUrl: 'https://console.groq.com/keys',
    runnable: true,
  },
  {
    key: 'azure-openai-llm',
    kind: 'llm',
    label: 'Azure OpenAI',
    // Endpoint is https://{resourceName}.openai.azure.com; deployment is the model.
    configFields: ['resourceName', 'deploymentName', 'apiVersion'],
    optionalFields: ['apiVersion'],
    defaults: { apiVersion: '2024-10-21' },
    secretFields: ['apiKey'],
    note:
      'Resource name is the subdomain of your endpoint (your-resource in ' +
      'https://your-resource.openai.azure.com). Deployment name is the label you chose when you ' +
      'deployed the model — not the model name. Residency follows the resource region.',
    keyUrl: 'https://ai.azure.com',
    runnable: true,
  },
  {
    key: 'bedrock-llm',
    kind: 'llm',
    label: 'AWS Bedrock',
    // SigV4 against bedrock-runtime.{region}.amazonaws.com. Region IS the residency.
    configFields: ['region'],
    secretFields: ['accessKeyId', 'secretAccessKey', 'sessionToken'],
    optionalFields: ['sessionToken'],
    note: 'IAM credentials with bedrock:InvokeModelWithResponseStream. Session token is optional (STS).',
    keyUrl: 'https://console.aws.amazon.com/bedrock/home#/modelaccess',
    runnable: true,
  },
  {
    key: 'vertex-llm',
    kind: 'llm',
    label: 'Google Vertex AI',
    configFields: ['projectId', 'location'],
    defaults: { location: 'us-central1' },
    secretFields: ['serviceAccount'],
    note: 'Paste the service-account JSON key. Location e.g. europe-west1 sets residency.',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    runnable: true,
  },

  // -- TTS -------------------------------------------------------------------
  {
    key: 'sarvam-stt',
    kind: 'stt',
    label: 'Sarvam AI (Saarika)',
    configFields: ['language'],
    optionalFields: ['language'],
    defaults: { language: 'en-IN' },
    secretFields: ['apiKey'],
    note:
      'Indian languages — Hindi, Bengali, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, ' +
      'Telugu, Gujarati and Indian English. Processing is in India, so a workspace pinned to ' +
      'a US or EU region cannot use it; pin to India (Mumbai) instead.',
    keyUrl: 'https://dashboard.sarvam.ai',
    runnable: true,
  },
  {
    key: 'sarvam-tts',
    kind: 'tts',
    label: 'Sarvam AI (Bulbul)',
    configFields: ['language', 'speaker'],
    optionalFields: ['language', 'speaker'],
    defaults: { language: 'en-IN', speaker: 'anushka' },
    secretFields: ['apiKey'],
    note:
      'Indian-language voices. One Sarvam account serves both STT and TTS, so the key is ' +
      'shared with sarvam-stt. Same India residency constraint.',
    keyUrl: 'https://dashboard.sarvam.ai',
    runnable: true,
  },
  {
    key: 'inworld-tts',
    kind: 'tts',
    label: 'Inworld',
    configFields: ['voice', 'model'],
    optionalFields: ['voice', 'model'],
    defaults: { voice: 'Ashley', model: 'inworld-tts-1.5-max' },
    secretFields: ['apiKey'],
    // Their key is issued base64-encoded; pasting the raw pair fails auth with a
    // 401 that reads like a wrong key rather than a wrongly-encoded one.
    note: 'Paste the Base64-encoded key from the Inworld portal, not the raw id:secret pair.',
    keyUrl: 'https://platform.inworld.ai',
    runnable: true,
  },
  {
    key: 'fishaudio-tts',
    kind: 'tts',
    label: 'Fish Audio',
    // referenceId selects a cloned/library voice; without one the model default speaks.
    configFields: ['referenceId', 'model'],
    optionalFields: ['referenceId', 'model'],
    defaults: { model: 's1' },
    secretFields: ['apiKey'],
    note: 'Reference ID is the voice model id from the Fish Audio library or your own clone.',
    keyUrl: 'https://fish.audio/go-api',
    runnable: true,
  },
  {
    key: 'cartesia-tts',
    kind: 'tts',
    label: 'Cartesia',
    configFields: [],
    secretFields: ['apiKey'],
    note: 'Lowest time-to-first-audio in the set.',
    keyUrl: 'https://play.cartesia.ai/keys',
    runnable: true,
  },
  {
    key: 'elevenlabs-tts',
    kind: 'tts',
    label: 'ElevenLabs',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    runnable: true,
  },
  {
    key: 'azure-tts',
    kind: 'tts',
    label: 'Azure TTS',
    configFields: ['region'],
    secretFields: ['apiKey'],
    note: 'Same Speech resource + region as Azure STT. Best Nordic coverage in the set.',
    keyUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    runnable: true,
  },
  {
    key: 'openai-tts',
    kind: 'tts',
    label: 'OpenAI TTS',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://platform.openai.com/api-keys',
    runnable: true,
  },
  {
    key: 'google-tts',
    kind: 'tts',
    label: 'Google Text-to-Speech',
    configFields: ['projectId'],
    secretFields: ['serviceAccount'],
    note: 'Service-account JSON key.',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    runnable: true,
  },
  {
    key: 'playht-tts',
    kind: 'tts',
    label: 'PlayHT',
    configFields: [],
    secretFields: ['apiKey', 'userId'],
    note:
      'PlayHT needs both the API key and the User ID from the same dashboard page. ' +
      'Storable and testable, but NOT yet runnable on a live call: LiveKit stopped shipping ' +
      'livekit-plugins-playai at 1.2.x and the worker runs 1.6.6. Pick another TTS to place calls.',
    keyUrl: 'https://play.ht/studio/api-access',
    // Deliberately false. Listing it as runnable would move the failure from a
    // dropdown label to a caller waiting in silence.
    runnable: false,
  },
  {
    key: 'rime-tts',
    kind: 'tts',
    label: 'Rime',
    configFields: [],
    secretFields: ['apiKey'],
    keyUrl: 'https://rime.ai/dashboard/tokens',
    runnable: true,
  },
];

/** Catalog lookup by key. The dashboard, the runtime handover and verification all need it. */
export function catalogEntry(key: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}

/**
 * Data postures for catalog entries that have NO control-plane factory.
 *
 * The control plane's in-process adapters exist for the simulator, the eval
 * harness and the fallback ladder. A live call does not use them at all — it
 * runs in the Python worker, which builds the vendor's own LiveKit plugin. So a
 * vendor can be perfectly runnable without us carrying a 500-line streaming
 * adapter for it.
 *
 * What the control plane *does* need either way is the posture, because the
 * eligibility gate fails closed on `undeclared_posture` — without an entry here
 * a workspace could store a Cartesia STT key, select it, and be refused at
 * dispatch with a compliance error that has nothing to do with compliance.
 *
 * `registerProviders` runs after these and overwrites any key that does have a
 * factory, so a real factory posture always wins.
 */
export const CATALOG_ONLY_POSTURES = [
  {
    key: 'cartesia-stt',
    kind: 'stt' as const,
    allowedBlocs: ['US'] as Array<'US' | 'EU'>,
    baaSigned: false,
    dpaSigned: true,
    retainsData: false,
    trainsOnData: false,
    selfHosted: false,
    notes:
      'Same Cartesia account and posture as their TTS. Runs in the worker via the Cartesia ' +
      'LiveKit plugin; the control plane has no in-process STT adapter for it.',
  },
  {
    key: 'sarvam-stt',
    kind: 'stt' as const,
    // India only. Declaring US/EU to make it selectable everywhere would be a lie the
    // eligibility gate then enforces — the point of that gate is that it cannot be
    // talked round.
    allowedBlocs: ['IN'] as Array<'US' | 'EU' | 'IN'>,
    baaSigned: false,
    dpaSigned: false,
    retainsData: false,
    trainsOnData: false,
    selfHosted: false,
    notes:
      'Indian-language ASR, processed in India. ⚖️ DPA/BAA status not verified — confirm with ' +
      'the vendor before processing personal data.',
  },
  {
    key: 'inworld-tts',
    kind: 'tts' as const,
    allowedBlocs: ['US'] as Array<'US' | 'EU' | 'IN'>,
    baaSigned: false,
    dpaSigned: false,
    retainsData: false,
    trainsOnData: false,
    selfHosted: false,
    notes: 'US-processed TTS. ⚖️ DPA/BAA status not verified — confirm before personal data.',
  },
  {
    key: 'fishaudio-tts',
    kind: 'tts' as const,
    allowedBlocs: ['US'] as Array<'US' | 'EU' | 'IN'>,
    baaSigned: false,
    dpaSigned: false,
    retainsData: false,
    trainsOnData: false,
    selfHosted: false,
    notes: 'US-processed TTS. ⚖️ DPA/BAA status not verified — confirm before personal data.',
  },
  {
    key: 'sarvam-tts',
    kind: 'tts' as const,
    allowedBlocs: ['IN'] as Array<'US' | 'EU' | 'IN'>,
    baaSigned: false,
    dpaSigned: false,
    retainsData: false,
    trainsOnData: false,
    selfHosted: false,
    notes:
      'Indian-language TTS, processed in India. Shares the Sarvam account and posture with ' +
      'sarvam-stt. ⚖️ DPA/BAA status not verified.',
  },
];

/**
 * Secret fields for a provider, prefixed as the resolver stores them
 * (`${vendor}.${field}`), e.g. `azure.openai.apiKey`.
 *
 * Derived from the catalog rather than hand-maintained in three places — the
 * previous copy in `api/v1/runtime.ts` drifted the moment a provider was added.
 * Only the vendor prefix is special-cased, because a few vendors namespace their
 * secrets differently from their catalog key.
 */
const SECRET_PREFIX: Record<string, string> = {
  // One Azure Speech resource serves both STT and TTS, so they share a secret
  // namespace: a customer adds the key once and both stages find it.
  'azure-speech-stt': 'azure.speech',
  'azure-tts': 'azure.speech',
  // Azure OpenAI is a different resource entirely from Azure Speech.
  'azure-openai-llm': 'azure.openai',
};

export function secretPrefixFor(providerKey: string): string {
  // Everything else drops the kind suffix: cartesia-tts and cartesia-stt both
  // resolve to `cartesia.apiKey`, which is correct — it is one Cartesia account.
  return SECRET_PREFIX[providerKey] ?? providerKey.replace(/-(llm|stt|tts)$/, '');
}

/**
 * Secret field names a call REQUIRES for this provider, fully prefixed.
 *
 * Optional fields (Bedrock's STS session token) are excluded: listing them would
 * make the runtime handover report them `missing` and refuse to start a call that
 * would have worked perfectly well with long-lived IAM keys.
 */
export function requiredSecretFieldNames(providerKey: string): string[] {
  const entry = catalogEntry(providerKey);
  if (!entry) return [];
  const optional = new Set(entry.optionalFields ?? []);
  const prefix = secretPrefixFor(providerKey);
  return entry.secretFields.filter((f) => !optional.has(f)).map((field) => `${prefix}.${field}`);
}

/** Every secret field, required or not — what the worker is offered. */
export function allSecretFieldNames(providerKey: string): string[] {
  const entry = catalogEntry(providerKey);
  if (!entry) return [];
  const prefix = secretPrefixFor(providerKey);
  return entry.secretFields.map((field) => `${prefix}.${field}`);
}
