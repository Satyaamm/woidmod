/**
 * The one place environment variables are read.
 *
 * Nothing else in the codebase touches `process.env`. Two reasons this matters
 * beyond tidiness:
 *
 *   1. **Validation at boot, not at use.** A missing `AUTH_HASH_PEPPER` should stop
 *      the process from starting in production, not surface as a broken login three
 *      hours later. Zod parses the whole environment once, here.
 *   2. **No hardcoded values anywhere.** A port, a URL, or a default region written
 *      inline in a service is a value that can't be changed without a code edit.
 *      Every such value lives in this schema with its default stated once.
 *
 * The single repo-root `.env.example` is the human-readable mirror of this schema —
 * if you add a field here, add it there.
 */

// Side-effect import: reads the repo-root `.env` into process.env BEFORE the schema
// below parses it. Must stay first so no env is read before the file is loaded.
import './load-env.js';

import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v !== '0' && v.toLowerCase() !== 'false'));

const envSchema = z.object({
  // -- Core ------------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3101),
  REGION: z.string().default('us-east'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Off by default: no demo orgs. A real user signs up and provisions their own
  // org/workspace. Set SEED=1 only if you want the two placeholder sample tenants.
  SEED: bool(false),

  // -- Persistence -----------------------------------------------------------
  // Absent => in-memory repositories (dev only). The container reads this to
  // decide which repository implementations to wire.
  DATABASE_URL: z.string().url().optional(),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().url().optional(),

  // -- Auth ------------------------------------------------------------------
  // Mandatory in production; dev gets ephemeral values with a warning.
  AUTH_SESSION_SECRET: z.string().min(16).optional(),
  AUTH_HASH_PEPPER: z.string().min(16).optional(),
  // Local dev only: return the email-verification code in the signup response.
  AUTH_EXPOSE_CODES: bool(false),

  // Refuse to dial a number whose statutory DNC registries cannot be screened (no
  // integration configured, or the lookup failed). Defaults ON: a screening
  // obligation you cannot discharge is a reason not to call. Set to 0 in a
  // deployment that has accepted the gap — it is then recorded on every audit row
  // rather than being invisible.
  DNC_REQUIRE_SCREENING: bool(true),

  /**
   * Commercial DNC scrubbing endpoints, one per statutory registry.
   *
   *   DNC_REGISTRY_PROVIDERS="us_national_dnc=https://vendor/dnc/{digits}|X-Api-Key: k|result.listed"
   *
   * `<registryKey>=<urlTemplate>[|<header>][|<resultPath>]`, semicolon-separated.
   * Vendor-neutral on purpose: the national registries (FTC, Bloctel, TPS)
   * distribute FILES rather than APIs, so the query-API half of the market is
   * commercial resellers who are interchangeable. Registries with no entry stay
   * `unavailable`, which is the honest state.
   */
  DNC_REGISTRY_PROVIDERS: z.string().optional(),

  // -- SSO (OAuth 2.0 / OIDC) — optional; a provider is live only when BOTH id+secret set.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),

  // -- RAG: pluggable vector store (bring your own) ---------------------------
  // Embeddings use the workspace's BYOK OpenAI key; the vector store is a
  // deployment choice. 'memory' (default) needs nothing; the others need creds.
  VECTOR_DB_PROVIDER: z.enum(['memory', 'pgvector', 'pinecone', 'chroma']).default('memory'),
  VECTOR_DB_CONNECTION_STRING: z.string().optional(), // pgvector
  VECTOR_DB_API_KEY: z.string().optional(), // pinecone / chroma
  VECTOR_DB_INDEX_HOST: z.string().optional(), // pinecone data-plane host
  VECTOR_DB_URL: z.string().optional(), // chroma server url
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),

  // -- Telephony carrier (Twilio) — platform-level fallback -------------------
  // Per-workspace BYOK Twilio creds (stored via provider credentials) win; these
  // env values are the fallback so a single-operator deployment can buy numbers.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),

  // -- SIP / PSTN (real phone calls) ------------------------------------------
  // The LiveKit SIP host a bought number is pointed at for inbound; our public URL
  // so Twilio can fetch the inbound TwiML; the LiveKit outbound trunk for placing
  // calls. All optional — SIP is inert until they're set (browser calls still work).
  LIVEKIT_SIP_URI: z.string().default(''), // e.g. sip:<project>.sip.livekit.cloud
  SIP_OUTBOUND_TRUNK_ID: z.string().default(''), // from CreateSIPOutboundTrunk
  PUBLIC_BASE_URL: z.string().default(''), // where Twilio reaches us, e.g. https://api.you.com

  // -- Encryption ------------------------------------------------------------
  // 32-byte hex master key for the dev LocalKms. Production uses a real KMS and
  // leaves this empty.
  KMS_MASTER_KEY: z.string().optional(),

  // -- LiveKit (media transport) ---------------------------------------------
  LIVEKIT_URL: z.string().default(''),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),

  // -- Object storage (S3-compatible: MinIO locally, S3/R2 in prod) -----------
  // For call recordings and transcripts.
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  // One bucket for all object storage; recordings and exports are separated by key
  // prefix (`recordings/…`, `exports/…`) rather than by bucket. Splitting into two
  // buckets later — for divergent lifecycle/retention or access policies — is a
  // config change, not a code change.
  S3_BUCKET: z.string().default('woidmod'),
  // MinIO needs path-style URLs; real S3 uses virtual-host style.
  S3_FORCE_PATH_STYLE: bool(true),

  // -- Frontend origin (CORS) ------------------------------------------------
  DASHBOARD_ORIGIN: z.string().default('http://localhost:3100'),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Production must not run on ephemeral auth secrets — a restart would silently
  // invalidate every session and every API key hash.
  if (env.NODE_ENV === 'production') {
    const missing = [
      !env.AUTH_SESSION_SECRET && 'AUTH_SESSION_SECRET',
      !env.AUTH_HASH_PEPPER && 'AUTH_HASH_PEPPER',
      !env.KMS_MASTER_KEY && 'KMS_MASTER_KEY',
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`production requires: ${missing.join(', ')}`);
    }
  }

  return env;
}

/** Parsed once at module load. Import this, never `process.env`. */
export const config: Env = load();

export const isProduction = config.NODE_ENV === 'production';
export const usePostgres = Boolean(config.DATABASE_URL);

/**
 * Provider secrets are BYOK ONLY — stored encrypted per tenant in the database,
 * never in this process's environment. There is no shared/platform key pool: a
 * customer brings their own Deepgram/Anthropic/Cartesia keys, or the worker
 * refuses the call and tells them exactly which credential to add.
 *
 * This function exists as the single failure point for "the code asked for a
 * platform key". It always throws, so any accidental reintroduction of a
 * platform-fallback path fails loudly at the call site instead of silently
 * reading an env var.
 */
export function platformSecret(logicalName: string): never {
  throw new Error(
    `no platform key for "${logicalName}" — provider credentials are BYOK. ` +
      `Add the key in the dashboard under Settings -> Providers.`,
  );
}
