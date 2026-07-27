/**
 * Integrations & webhooks — domain schemas.
 *
 * The wire shapes here match the dashboard's `WebhookEndpoint`, `WebhookDelivery`
 * and `IntegrationProvider` types field-for-field (frontend/src/lib/contract.ts).
 *
 * One deliberate asymmetry: `signingSecret` on an endpoint view is ALWAYS masked
 * (`whsec_7f2c…`). The full secret is minted on create/rotate, hashed at rest, and
 * returned to the caller exactly once. There is no endpoint that reveals it again —
 * a leaked signing key is rotated, not looked up.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Events

export const WEBHOOK_EVENTS = [
  'call.started',
  'call.completed',
  'call.failed',
  'transcript.ready',
  'recording.ready',
  'tool.invoked',
  'agent.published',
  'eval.run.completed',
  'compliance.flagged',
] as const;

export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const webhookDeliveryStatusSchema = z.enum([
  'delivered',
  'failed',
  'pending',
  'retrying',
]);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;

// ---------------------------------------------------------------------------
// Endpoint view (masked)

export interface WebhookEndpointStats {
  deliveredLast24h: number;
  failedLast24h: number;
  p95LatencyMs: number;
}

/** The endpoint as returned on the wire. `signingSecret` is always masked. */
export interface WebhookEndpoint {
  id: string;
  workspaceId: string;
  url: string;
  description?: string;
  enabled: boolean;
  events: WebhookEvent[];
  /**
   * Masked hint only (`whsec_7f2c…`). The full secret is returned once from
   * create/rotate and never again.
   */
  signingSecret: string;
  signingSecretRotatedAt: string;
  maxAttempts: number;
  stats: WebhookEndpointStats;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Delivery view

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: WebhookEvent;
  /** The call / agent / run this delivery is about. */
  resourceId: string;
  attempt: number;
  maxAttempts: number;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  latencyMs: number;
  requestBody: unknown;
  responseBody: string | null;
  error?: string;
  createdAt: string;
  nextRetryAt?: string;
  /** Set when this delivery was produced by replaying an earlier one. */
  replayOfId?: string;
}

// ---------------------------------------------------------------------------
// Integration catalog

export const integrationKindSchema = z.enum([
  'crm',
  'calendar',
  'helpdesk',
  'ccaas',
  'webhook',
  'storage',
]);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

export const integrationStatusSchema = z.enum([
  'connected',
  'available',
  'coming_soon',
  'error',
]);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export interface IntegrationProvider {
  key: string;
  name: string;
  kind: IntegrationKind;
  /** One line: what connecting this actually does. */
  description: string;
  status: IntegrationStatus;
  docsUrl?: string;
  /** Set when `status === 'connected'`. */
  connectedAt?: string;
  /** e.g. the connected account's email or tenant name. */
  accountLabel?: string;
  /** Set when `status === 'error'`. */
  error?: string;
}

/**
 * Static catalog — the integrations screen. Deliberately honest: everything not
 * shipped is `coming_soon` rather than a greyed-out logo pretending otherwise.
 */
export const INTEGRATION_CATALOG: readonly IntegrationProvider[] = [
  {
    key: 'webhooks',
    name: 'Webhooks',
    kind: 'webhook',
    description:
      'Push call, transcript and eval events to your own endpoint, signed with HMAC-SHA256. Failed deliveries are retried and can be replayed by hand.',
    status: 'available',
    docsUrl: 'https://docs.woidmod.example/webhooks',
  },
  {
    key: 'slack',
    name: 'Slack',
    kind: 'ccaas',
    description: 'Post call outcomes, escalations and compliance flags into a channel as they happen.',
    status: 'coming_soon',
    docsUrl: 'https://docs.woidmod.example/integrations/slack',
  },
  {
    key: 'zapier',
    name: 'Zapier',
    kind: 'webhook',
    description: 'Fan events out to 6,000+ apps without writing a receiver — pick a trigger, map the fields, done.',
    status: 'coming_soon',
    docsUrl: 'https://docs.woidmod.example/integrations/zapier',
  },
  {
    key: 'hubspot',
    name: 'HubSpot',
    kind: 'crm',
    description: 'Write call outcomes and transcripts onto the matching contact, and read contact context before the call.',
    status: 'coming_soon',
    docsUrl: 'https://docs.woidmod.example/integrations/hubspot',
  },
  {
    key: 'salesforce',
    name: 'Salesforce',
    kind: 'crm',
    description: 'Same as HubSpot, plus Task creation against the Account. Needs a connected app and OAuth scopes.',
    status: 'coming_soon',
  },
  {
    key: 'google_calendar',
    name: 'Google Calendar',
    kind: 'calendar',
    description: 'Let an agent read free/busy and book slots directly, instead of you writing a booking tool by hand.',
    status: 'coming_soon',
  },
  {
    key: 'zendesk',
    name: 'Zendesk',
    kind: 'helpdesk',
    description: 'Open a ticket when an agent escalates, with the transcript attached.',
    status: 'coming_soon',
  },
  {
    key: 's3_export',
    name: 'S3 / GCS export',
    kind: 'storage',
    description: 'Scheduled export of recordings and transcripts into your own bucket, in your own region.',
    status: 'coming_soon',
  },
];

// ---------------------------------------------------------------------------
// Inputs

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), { message: 'webhook URL must be https://' });

export const createWebhookInput = z.object({
  url: httpsUrl,
  description: z.string().max(300).optional(),
  events: z.array(webhookEventSchema).min(1, 'subscribe to at least one event'),
  enabled: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(10).default(6),
});
export type CreateWebhookInput = z.infer<typeof createWebhookInput>;

export const updateWebhookInput = z
  .object({
    url: httpsUrl,
    description: z.string().max(300),
    events: z.array(webhookEventSchema).min(1),
    enabled: z.boolean(),
    maxAttempts: z.number().int().min(1).max(10),
  })
  .partial();
export type UpdateWebhookInput = z.infer<typeof updateWebhookInput>;

export const testEventInput = z.object({
  event: webhookEventSchema,
});
export type TestEventInput = z.infer<typeof testEventInput>;
