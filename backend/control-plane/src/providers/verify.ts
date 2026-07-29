/**
 * Live credential verification — does this key actually work, right now?
 *
 * The structural check in `provider-credentials.ts` only proved a secret decrypts
 * and is non-empty. That catches a half-filled form and a crypto-shredded tenant
 * key, and nothing else: a revoked Deepgram key, a typo'd Azure deployment name,
 * a PlayHT key paired with the wrong user id and an EU-only Speechmatics key all
 * pass it and then fail on a live call, in front of a caller.
 *
 * So each provider gets a real handshake against the vendor. Three rules shape
 * every probe below:
 *
 *   1. **Cheap and read-only.** An authenticated GET the vendor charges nothing
 *      for — list projects, list voices, list models, mint a token. The two
 *      exceptions (Azure OpenAI, Rime) are documented at their probes, and both
 *      are single-token requests.
 *   2. **Tests what the call will actually use.** Azure OpenAI routes on the
 *      DEPLOYMENT name, not the model, so listing models would pass while every
 *      call 404s. The probe hits the customer's own deployment.
 *   3. **Distinguishes "key is wrong" from "we couldn't reach the vendor".** A
 *      DNS blip must not mark a good credential invalid — that would silently
 *      remove it from the resolver on the next call (see `resolverFor`, which
 *      skips anything marked invalid).
 *
 * Endpoints and auth headers here were taken from the adapters in `adapters/*`,
 * which carry their own VERIFIED-with-date citations to vendor docs, and
 * re-checked against those docs on 2026-07-28.
 */

import { createHash, createHmac, createSign } from 'node:crypto';

/** How long a probe may take before we call it unreachable rather than invalid. */
const PROBE_TIMEOUT_MS = 10_000;

export interface VerifyInput {
  /** Catalog key, e.g. `azure-openai-llm`. */
  providerKey: string;
  /** Non-secret routing fields, keyed as the catalog names them (`region`, …). */
  config: Record<string, unknown>;
  /** Decrypted secret fields, keyed as the catalog names them (`apiKey`, …). */
  secrets: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  /**
   * `live` = we talked to the vendor. `structural` = we could not, and the
   * result reflects field presence only. The UI must not imply a live check
   * happened when it did not.
   */
  checked: 'live' | 'structural';
  /** One line, written for the person who just pasted the key. */
  message: string;
  /** Vendor-reported HTTP status, when there was one. Useful in support. */
  status?: number;
}

/** Thrown by a probe when the vendor was unreachable — not a bad credential. */
class Unreachable extends Error {}

/**
 * Thrown when the host itself does not exist.
 *
 * Separate from `Unreachable` because it is not a network blip: every endpoint
 * here is a fixed vendor domain except the ones built from customer input
 * (Azure's `{resourceName}.openai.azure.com`, Speechmatics' data-centre hosts,
 * an OpenAI-compatible gateway's base URL). So DNS failing almost always means a
 * routing field is wrong, and reporting "check your network" would send the
 * customer looking in entirely the wrong place.
 */
class HostNotFound extends Error {}

/**
 * Runs the live probe for one provider.
 *
 * Never throws: a provider with no probe returns `checked: 'structural'`, and a
 * transport failure returns `ok: false` with a message that says so. The caller
 * decides what to persist.
 */
export async function verifyCredentialLive(input: VerifyInput): Promise<VerifyResult> {
  const probe = PROBES[input.providerKey];
  if (!probe) {
    return {
      ok: true,
      checked: 'structural',
      message:
        `No live check exists for "${input.providerKey}" yet — the stored fields are ` +
        `present and decrypt, but the vendor has not confirmed the key.`,
    };
  }

  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    return await probe({ ...input, signal });
  } catch (error) {
    if (error instanceof HostNotFound) {
      // A host that does not exist IS a failed check — the customer typed it.
      const azure = error.message.endsWith('.openai.azure.com');
      return {
        ok: false,
        checked: 'live',
        message:
          `No such host: ${error.message}. That address is built from the routing fields ` +
          (azure
            ? `above — check the resource name. It is the subdomain of your Azure endpoint ` +
              `("your-resource" in https://your-resource.openai.azure.com), not the deployment ` +
              `and not the model.`
            : `above, so one of them is wrong.`),
      };
    }
    if (error instanceof Unreachable) {
      return {
        ok: false,
        checked: 'structural',
        message: `Could not reach the provider: ${error.message}. The key was not tested.`,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, checked: 'live', message: detail };
  }
}

// ---------------------------------------------------------------------------
// Probe plumbing
// ---------------------------------------------------------------------------

interface ProbeInput extends VerifyInput {
  signal: AbortSignal;
}

type Probe = (input: ProbeInput) => Promise<VerifyResult>;

function required(input: VerifyInput, bag: 'config' | 'secrets', field: string): string {
  const value = String(input[bag][field] ?? '').trim();
  if (!value) throw new Error(`"${field}" is required for ${input.providerKey} but is empty.`);
  return value;
}

function optional(input: VerifyInput, bag: 'config' | 'secrets', field: string): string {
  return String(input[bag][field] ?? '').trim();
}

/**
 * fetch + a uniform failure vocabulary.
 *
 * A transport error (DNS, TLS, timeout) becomes `Unreachable`; anything that
 * came back with a status is a real answer from the vendor, however unhappy.
 */
async function call(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  /**
   * True when the hostname came from a field the customer typed. Only then is a
   * DNS failure their problem: `api.deepgram.com` not resolving is our network,
   * `wrong-resource.openai.azure.com` not resolving is their resource name.
   */
  hostFromInput = false,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    // Undici hides the useful code on `cause`; the outer message is always the
    // uninformative "fetch failed".
    const code = (error as { cause?: { code?: string } })?.cause?.code ?? '';
    if (hostFromInput && (code === 'ENOTFOUND' || code === 'EAI_AGAIN')) {
      throw new HostNotFound(new URL(url).host);
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new Unreachable(
      cause.includes('aborted') || cause.includes('timeout')
        ? `no response within ${PROBE_TIMEOUT_MS / 1000}s`
        : cause,
    );
  }
}

/**
 * The one useful sentence out of a vendor error body.
 *
 * Every vendor nests it somewhere different — `error.message`, `message`,
 * `detail`, `detail.message` — and a couple answer with an HTML error page from
 * a load balancer that never reached their API. Pasting either raw into the UI
 * gives the customer a wall of JSON or a chunk of `<html>` to read, so unwrap
 * what we can and drop what we can't.
 */
async function detailOf(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';

    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const unwrap = (value: unknown): string | undefined => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
          const nested = (value as Record<string, unknown>)['message'];
          if (typeof nested === 'string') return nested;
        }
        return undefined;
      };
      const message =
        unwrap(parsed['error']) ??
        unwrap(parsed['message']) ??
        unwrap(parsed['detail']) ??
        unwrap(parsed['error_message']);
      if (message) return message.slice(0, 200);
      // JSON we could not unwrap is still better than nothing, just truncated.
      return text.slice(0, 200);
    } catch {
      /* not JSON */
    }

    // An HTML error page tells the customer nothing they can act on; the status
    // code already carried the whole signal.
    if (/^\s*<(?:!doctype|html)/i.test(text)) return '';
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Turns a vendor response into a verdict.
 *
 * 401/403 is the only unambiguous "your credential is wrong". 404 usually means
 * a routing field (resource, deployment, region, project) is wrong, which is
 * equally the customer's to fix. 5xx and 429 are the vendor having a bad day —
 * failing the credential for that would be wrong, so they are reported as
 * untested rather than invalid.
 */
async function verdict(
  response: Response,
  ok: string,
  hints: { rejected?: string; notFound?: string } = {},
): Promise<VerifyResult> {
  if (response.ok) {
    return { ok: true, checked: 'live', message: ok, status: response.status };
  }

  const detail = await detailOf(response);
  const suffix = detail ? ` — ${detail}` : '';

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      checked: 'live',
      status: response.status,
      message: (hints.rejected ?? 'The provider rejected this credential') + suffix,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      checked: 'live',
      status: response.status,
      message:
        (hints.notFound ?? 'The provider returned 404 — check the routing fields') + suffix,
    };
  }
  // Not every vendor uses 401 for a bad key. Google AI Studio answers
  // `400 API key not valid`, and a few others fold auth into a generic bad
  // request. Reporting that as "the provider returned 400" is technically true
  // and useless — the customer needs to be told their key was rejected.
  if (
    response.status === 400 &&
    /api[\s_-]?key|unauthor|authentication|credential|token/i.test(detail)
  ) {
    return {
      ok: false,
      checked: 'live',
      status: response.status,
      message: (hints.rejected ?? 'The provider rejected this credential') + suffix,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      checked: 'structural',
      status: response.status,
      message:
        `The provider returned ${response.status}, which is their side, not your key${suffix}. ` +
        `Try again shortly.`,
    };
  }
  return {
    ok: false,
    checked: 'live',
    status: response.status,
    message: `The provider returned ${response.status}${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// Google service-account auth (shared by google-stt, google-tts, vertex-llm)
// ---------------------------------------------------------------------------

/**
 * Mints a Google access token from a service-account JSON key.
 *
 * Mirrors `adapters/vertex-llm.ts` exactly — self-signed RS256 JWT exchanged at
 * the token endpoint for an access token.
 * https://developers.google.com/identity/protocols/oauth2/service-account
 *
 * This IS the credential test for every Google surface: if the key material is
 * revoked, malformed, or belongs to a deleted service account, the exchange
 * fails here with a precise reason.
 */
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

function parseServiceAccountJson(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'The service account is not valid JSON. Paste the whole key file, including the braces.',
    );
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) {
    throw new Error(
      'That JSON is missing "client_email" or "private_key" — it is probably an OAuth client ' +
        'file rather than a service-account key.',
    );
  }
  return sa as ServiceAccount;
}

async function mintGoogleToken(raw: string, signal: AbortSignal): Promise<string> {
  const sa = parseServiceAccountJson(raw);
  const tokenUri = sa.token_uri ?? GOOGLE_TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);

  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: sa.client_email,
    scope: GOOGLE_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;

  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
  } catch {
    throw new Error(
      'The "private_key" in that JSON could not be used to sign. It is usually mangled newlines ' +
        '— paste the key file verbatim rather than retyping it.',
    );
  }

  const response = await call(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }).toString(),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Google rejected the service account — ${await detailOf(response)}`);
  }
  const token = (JSON.parse(await response.text()) as { access_token?: string }).access_token;
  if (!token) throw new Error('Google returned no access token for this service account.');
  return token;
}

/** Every Google surface authenticates the same way; only the wording differs. */
function googleProbe(surface: string): Probe {
  return async (input) => {
    const token = await mintGoogleToken(required(input, 'secrets', 'serviceAccount'), input.signal);
    const project = optional(input, 'config', 'projectId');
    return {
      ok: true,
      checked: 'live',
      message:
        `Google accepted the service account and issued an access token for ${surface}` +
        (project ? ` (project ${project}).` : '.') +
        // Token minting proves the key, not the IAM grant. Saying so is more
        // useful than a bare "valid" that a 403 later contradicts.
        ` Make sure the account also has the ${surface} role on the project.`,
      status: token ? 200 : undefined,
    };
  };
}

// ---------------------------------------------------------------------------
// AWS SigV4 (bedrock-llm)
// ---------------------------------------------------------------------------

/**
 * Signs a GET with no query string and an empty body — the narrowest useful
 * subset of SigV4, which is all `ListFoundationModels` needs.
 *
 * Canonicalisation rules per
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 * and identical to the POST signer in `adapters/bedrock-llm.ts`: canonical
 * request is METHOD \n URI \n QUERY \n HEADERS \n SIGNED \n PAYLOAD-HASH, the
 * signing key is the HMAC chain over date -> region -> service -> aws4_request,
 * and the timestamp carries no milliseconds.
 *
 * Note the service name is `bedrock` and the host is `bedrock.{region}` — the
 * control-plane endpoint, not the `bedrock-runtime.{region}` inference host, so
 * a probe cannot accidentally invoke a model.
 */
function signGet(opts: {
  host: string;
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): Record<string, string> {
  const algorithm = 'AWS4-HMAC-SHA256';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update('', 'utf8').digest('hex');

  const headers: Record<string, string> = {
    host: opts.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.sessionToken) headers['x-amz-security-token'] = opts.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${(headers[n] ?? '').trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    'GET',
    opts.path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const hmac = (key: string | Buffer, value: string) =>
    createHmac('sha256', key).update(value, 'utf8').digest();
  const signing = hmac(
    hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, dateStamp), opts.region), opts.service),
    'aws4_request',
  );
  const signature = hmac(signing, stringToSign).toString('hex');

  // `host` is set by fetch; writing it here would be a forbidden-header write.
  // It stays in the signature, which is the part that matters.
  delete headers['host'];
  headers['authorization'] =
    `${algorithm} Credential=${opts.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

/**
 * Base URL for an Azure Speech resource's token endpoint.
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
 * Issuing a token is the canonical way to prove a Speech key + region pair, and
 * it is free — the same check the Speech SDK performs on connect.
 */
async function azureSpeechProbe(input: ProbeInput, surface: string): Promise<VerifyResult> {
  const key = required(input, 'secrets', 'apiKey');
  const region = required(input, 'config', 'region');
  const response = await call(
    `https://${encodeURIComponent(region)}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key }, signal: input.signal },
  );
  return verdict(response, `Azure issued a ${surface} token for region "${region}".`, {
    rejected: `Azure rejected this Speech key for region "${region}". A key is bound to one region`,
    notFound: `No Speech resource answered in region "${region}" — check the region spelling`,
  });
}

/** Cartesia's authenticated voice list. Shared by their TTS and their Ink STT. */
const cartesiaProbe: Probe = async (input) => {
  const response = await call('https://api.cartesia.ai/voices?limit=1', {
    headers: {
      authorization: `Bearer ${required(input, 'secrets', 'apiKey')}`,
      'Cartesia-Version': '2026-03-01',
    },
    signal: input.signal,
  });
  return verdict(response, 'Cartesia accepted the key and listed your voices.', {
    rejected: 'Cartesia rejected this API key',
  });
};

/** OpenAI-wire `GET /models`, shared by OpenAI, Groq and OpenAI-compatible gateways. */
async function openAiModelsProbe(
  input: ProbeInput,
  opts: { baseUrl: string; vendor: string; hostFromInput?: boolean },
): Promise<VerifyResult> {
  const key = required(input, 'secrets', 'apiKey');
  const organization = optional(input, 'config', 'organization');
  const response = await call(
    `${opts.baseUrl.replace(/\/+$/, '')}/models`,
    {
      headers: {
        authorization: `Bearer ${key}`,
        ...(organization ? { 'OpenAI-Organization': organization } : {}),
      },
      signal: input.signal,
    },
    opts.hostFromInput ?? false,
  );
  return verdict(response, `${opts.vendor} accepted the key and listed the available models.`, {
    rejected: `${opts.vendor} rejected this API key`,
    notFound: `Nothing answered at ${opts.baseUrl} — check the base URL`,
  });
}

const PROBES: Record<string, Probe> = {
  // -- STT -------------------------------------------------------------------

  /**
   * https://developers.deepgram.com/reference/manage/projects/list —
   * `GET https://api.deepgram.com/v1/projects`, `Authorization: Token <key>`.
   * Note `Token`, not `Bearer`: a Bearer prefix returns 401 with a valid key.
   */
  'deepgram-stt': async (input) => {
    const response = await call('https://api.deepgram.com/v1/projects', {
      headers: { authorization: `Token ${required(input, 'secrets', 'apiKey')}` },
      signal: input.signal,
    });
    return verdict(response, 'Deepgram accepted the key and listed your projects.', {
      rejected: 'Deepgram rejected this API key',
    });
  },

  /**
   * AssemblyAI authenticates with the bare key in `Authorization` — no scheme
   * prefix (see `adapters/assemblyai-stt.ts`, verified against their streaming
   * API reference). Listing one transcript is the cheapest authenticated read.
   */
  'assemblyai-stt': async (input) => {
    const response = await call('https://api.assemblyai.com/v2/transcript?limit=1', {
      headers: { authorization: required(input, 'secrets', 'apiKey') },
      signal: input.signal,
    });
    return verdict(response, 'AssemblyAI accepted the key.', {
      rejected: 'AssemblyAI rejected this API key',
    });
  },

  'azure-speech-stt': (input) => azureSpeechProbe(input, 'speech-to-text'),

  /**
   * https://docs.speechmatics.com/introduction/authentication — `Bearer` against
   * the Jobs API. Speechmatics runs separate EU and US data centres on different
   * hosts and a key is issued for one of them, so we try EU then US and report
   * which one answered: a key that works in only one region is a real
   * configuration fact the customer needs, not a failure.
   */
  'speechmatics-stt': async (input) => {
    const key = required(input, 'secrets', 'apiKey');
    const hosts: Array<[string, string]> = [
      ['eu2.asr.api.speechmatics.com', 'EU'],
      ['asr.api.speechmatics.com', 'US'],
    ];
    let last: VerifyResult | null = null;
    for (const [host, label] of hosts) {
      const response = await call(`https://${host}/v2/jobs?limit=1`, {
        headers: { authorization: `Bearer ${key}` },
        signal: input.signal,
      });
      const result = await verdict(response, `Speechmatics accepted the key in the ${label} data centre.`, {
        rejected: `Speechmatics rejected this key in the ${label} data centre`,
      });
      if (result.ok) return result;
      last = result;
    }
    return (
      last ?? { ok: false, checked: 'live', message: 'Speechmatics rejected this API key.' }
    );
  },

  /**
   * https://soniox.com/docs/api-reference/stt/get_models —
   * `GET https://api.soniox.com/v1/models`, `Authorization: Bearer <key>`.
   */
  'soniox-stt': async (input) => {
    const response = await call('https://api.soniox.com/v1/models', {
      headers: { authorization: `Bearer ${required(input, 'secrets', 'apiKey')}` },
      signal: input.signal,
    });
    return verdict(response, 'Soniox accepted the key and listed its models.', {
      rejected: 'Soniox rejected this API key',
    });
  },

  'google-stt': googleProbe('Speech-to-Text'),

  // -- LLM -------------------------------------------------------------------

  /**
   * https://platform.claude.com/docs/en/api/models-list — `x-api-key` plus the
   * required `anthropic-version` header. Omitting the version header returns
   * 400 even with a perfectly good key, which would read as "invalid".
   */
  'anthropic-llm': async (input) => {
    const response = await call('https://api.anthropic.com/v1/models?limit=1', {
      headers: {
        'x-api-key': required(input, 'secrets', 'apiKey'),
        'anthropic-version': '2023-06-01',
      },
      signal: input.signal,
    });
    return verdict(response, 'Anthropic accepted the key and listed its models.', {
      rejected: 'Anthropic rejected this API key',
    });
  },

  /** `baseUrl` lets an OpenAI-compatible gateway (LiteLLM, OpenRouter, vLLM) be tested too. */
  'openai-llm': (input) => {
    const baseUrl = optional(input, 'config', 'baseUrl');
    return openAiModelsProbe(input, {
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      vendor: baseUrl ? 'The gateway' : 'OpenAI',
      // Only when the customer supplied the URL is a DNS failure theirs.
      hostFromInput: Boolean(baseUrl),
    });
  },

  /**
   * https://ai.google.dev/api/models — AI Studio keys go in the `x-goog-api-key`
   * header (the `?key=` query form also works but leaks the key into vendor logs
   * and any proxy in between, so we use the header).
   */
  'gemini-llm': async (input) => {
    const response = await call(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      {
        headers: { 'x-goog-api-key': required(input, 'secrets', 'apiKey') },
        signal: input.signal,
      },
    );
    return verdict(response, 'Google AI Studio accepted the key and listed its models.', {
      rejected: 'Google AI Studio rejected this API key',
    });
  },

  'groq-llm': (input) =>
    openAiModelsProbe(input, { baseUrl: 'https://api.groq.com/openai/v1', vendor: 'Groq' }),

  /**
   * The only probe that spends money, and it is worth it.
   *
   * Azure routes on the DEPLOYMENT name, not the model — so listing models would
   * pass while every real call 404s on a typo'd deployment. This posts a
   * one-token completion to the customer's own deployment, which is the exact
   * path a call takes and proves all four moving parts at once: resource name,
   * deployment name, api-version and key. Cost is a fraction of a cent.
   *
   * Both API surfaces are handled: `apiVersion: 'v1'` selects the undated
   * `/openai/v1/` surface, anything else is the dated
   * `/openai/deployments/{d}/…?api-version=…` surface. Same split as
   * `adapters/azure-openai-llm.ts`.
   */
  'azure-openai-llm': async (input) => {
    const key = required(input, 'secrets', 'apiKey');
    const deployment = required(input, 'config', 'deploymentName');
    const apiVersion = optional(input, 'config', 'apiVersion') || '2024-10-21';

    // `endpoint` first: an AI Foundry resource is served from
    // {resource}.services.ai.azure.com, which cannot be expressed as a resource
    // name. `resourceName` remains the shorthand for the classic host, and a
    // customer who pasted a whole URL into it is the most common support ticket
    // here — so accept that too rather than failing on their behalf.
    const endpoint = optional(input, 'config', 'endpoint');
    const resource = endpoint || optional(input, 'config', 'resourceName');
    if (!resource) {
      throw new Error(
        'azure-openai-llm needs an endpoint: paste the URL from the portal ' +
          '(https://<resource>.services.ai.azure.com for AI Foundry), or give a resource name.',
      );
    }

    const host = /^https?:\/\//i.test(resource)
      ? new URL(resource).origin
      : `https://${resource}.openai.azure.com`;

    const url =
      apiVersion === 'v1'
        ? `${host}/openai/v1/chat/completions`
        : `${host}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions` +
          `?api-version=${encodeURIComponent(apiVersion)}`;

    const response = await call(url, {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(apiVersion === 'v1' ? { model: deployment } : {}),
        messages: [{ role: 'user', content: 'hi' }],
        // Reasoning deployments (o-series, gpt-5) reject `max_tokens`. Sending
        // both is not allowed either, so send the one every deployment accepts
        // and let a 1-token cap be approximate.
        max_completion_tokens: 1,
      }),
      signal: input.signal,
    },
      // Host is `{resourceName}.openai.azure.com` — built from customer input.
      true,
    );

    // A reasoning deployment can answer 400 "max_completion_tokens too small"
    // or similar — the key and routing were still accepted, which is what we
    // are testing. Only auth and routing failures are real failures here.
    if (response.status === 400) {
      const detail = await detailOf(response);
      return {
        ok: true,
        checked: 'live',
        status: 400,
        message:
          `Azure accepted the key and reached deployment "${deployment}", and rejected only the ` +
          `probe's own parameters (${detail || 'bad request'}). The credential is good.`,
      };
    }

    return verdict(
      response,
      `Azure accepted the key and deployment "${deployment}" responded on resource "${resource}".`,
      {
        rejected: `Azure rejected this key for resource "${resource}"`,
        notFound:
          `Azure has no deployment named "${deployment}" on resource "${resource}" ` +
          `(or api-version "${apiVersion}" is wrong). The deployment name is the label you ` +
          `chose in Azure AI Foundry, not the model name`,
      },
    );
  },

  /**
   * SigV4 `GET https://bedrock.{region}.amazonaws.com/foundation-models`.
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
   *
   * Requires `bedrock:ListFoundationModels`. A 403 here therefore means either
   * bad keys or an IAM policy that is too narrow, and the message says both,
   * because "invalid key" would send the customer to rotate a perfectly good one.
   */
  'bedrock-llm': async (input) => {
    const region = required(input, 'config', 'region');
    const host = `bedrock.${region}.amazonaws.com`;
    const path = '/foundation-models';
    const sessionToken = optional(input, 'secrets', 'sessionToken');

    const headers = signGet({
      host,
      path,
      region,
      service: 'bedrock',
      accessKeyId: required(input, 'secrets', 'accessKeyId'),
      secretAccessKey: required(input, 'secrets', 'secretAccessKey'),
      ...(sessionToken ? { sessionToken } : {}),
    });

    const response = await call(`https://${host}${path}`, { headers, signal: input.signal });
    return verdict(response, `AWS accepted these IAM credentials in ${region}.`, {
      rejected:
        `AWS rejected the request in ${region}. Either the IAM keys are wrong, or the ` +
        `principal is missing bedrock:ListFoundationModels and bedrock:InvokeModelWithResponseStream`,
      notFound: `Bedrock is not available in region "${region}" — check the region`,
    });
  },

  'vertex-llm': googleProbe('Vertex AI'),

  // -- TTS -------------------------------------------------------------------

  /**
   * https://docs.cartesia.ai/api-reference/voices/list — Bearer auth plus the
   * REQUIRED `Cartesia-Version` header. Without the version header Cartesia
   * answers 400 regardless of the key, which would read as "invalid key".
   *
   * Registered for `cartesia-stt` too (below): one Cartesia account serves both
   * speech-to-text and text-to-speech, so the same probe proves the same key.
   */
  'cartesia-tts': cartesiaProbe,
  'cartesia-stt': cartesiaProbe,

  /** https://elevenlabs.io/docs/api-reference/voices/get-all — `xi-api-key` header. */
  'elevenlabs-tts': async (input) => {
    const response = await call('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': required(input, 'secrets', 'apiKey') },
      signal: input.signal,
    });
    return verdict(response, 'ElevenLabs accepted the key and listed your voices.', {
      rejected: 'ElevenLabs rejected this API key',
    });
  },

  'azure-tts': (input) => azureSpeechProbe(input, 'text-to-speech'),

  'openai-tts': (input) =>
    openAiModelsProbe(input, { baseUrl: 'https://api.openai.com/v1', vendor: 'OpenAI' }),

  'google-tts': googleProbe('Text-to-Speech'),

  /**
   * https://docs.play.ht/reference/api-getting-started — PlayHT needs BOTH the
   * key and the user id, and the key goes in `AUTHORIZATION` with no `Bearer`
   * prefix. Mismatched pairs are the single most common PlayHT misconfiguration,
   * and this catches them.
   */
  'playht-tts': async (input) => {
    const response = await call('https://api.play.ht/api/v2/voices', {
      headers: {
        AUTHORIZATION: required(input, 'secrets', 'apiKey'),
        'X-USER-ID': required(input, 'secrets', 'userId'),
        accept: 'application/json',
      },
      signal: input.signal,
    });
    return verdict(response, 'PlayHT accepted the key and user id, and listed your voices.', {
      rejected: 'PlayHT rejected this key/user-id pair — both come from the same dashboard page',
    });
  },

  /**
   * Rime's voice catalogue is a public JSON file, so it proves nothing about a
   * key. The cheapest authenticated call is therefore a synthesis — one full
   * stop, at the lowest sample rate, discarded. Fractions of a cent, and it
   * exercises the exact endpoint a call uses.
   * https://docs.rime.ai/api-reference/endpoint/streaming-pcm
   */
  'rime-tts': async (input) => {
    const response = await call('https://users.rime.ai/v1/rime-tts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${required(input, 'secrets', 'apiKey')}`,
        'content-type': 'application/json',
        accept: 'audio/L16',
      },
      body: JSON.stringify({
        text: '.',
        modelId: 'mistv2',
        speaker: 'rainforest',
        samplingRate: 8000,
      }),
      signal: input.signal,
    });
    return verdict(response, 'Rime accepted the key and synthesised a test sample.', {
      rejected: 'Rime rejected this API key',
    });
  },
};

/** Provider keys that have a real live probe — used by the UI to set expectations. */
export function providersWithLiveVerification(): string[] {
  return Object.keys(PROBES).sort();
}
