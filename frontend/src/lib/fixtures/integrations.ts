/** ⚠️ LOCAL FIXTURES — see ./index.ts. Integration catalogue + webhook deliveries. */
import type {
  IntegrationProvider,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEvent,
} from '@/lib/contract';

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

/**
 * Deliberately short and honest. A wall of greyed-out logos for things nobody
 * has started building is a lie with a nice layout.
 */
export const integrationFixtures: IntegrationProvider[] = [
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
    key: 'cal_com',
    name: 'Cal.com',
    kind: 'calendar',
    description: 'Booking links and availability for teams already using Cal.com.',
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

export const webhookEndpointFixtures: WebhookEndpoint[] = [
  {
    id: 'whk_prod',
    workspaceId: 'ws_fixture',
    url: 'https://hooks.example.com/woidmod/events',
    description: 'Primary event sink — writes into the CRM queue.',
    enabled: true,
    events: ['call.completed', 'call.failed', 'transcript.ready', 'compliance.flagged'],
    signingSecret: 'whsec_7f2c9a1b4e6d8g0h2j4k6m8n0p2q4r6s',
    signingSecretRotatedAt: iso(60 * 24 * 41),
    maxAttempts: 6,
    stats: { deliveredLast24h: 1_284, failedLast24h: 7, p95LatencyMs: 214 },
    createdAt: iso(60 * 24 * 41),
  },
  {
    id: 'whk_evals',
    workspaceId: 'ws_fixture',
    url: 'https://ci.example.com/woidmod/eval-hook',
    description: 'Fails the CI job when an eval run regresses.',
    enabled: true,
    events: ['eval.run.completed', 'agent.published'],
    signingSecret: 'whsec_2b4d6f8h0j2l4n6p8r0t2v4x6z8b0d2f',
    signingSecretRotatedAt: iso(60 * 24 * 6),
    maxAttempts: 3,
    stats: { deliveredLast24h: 12, failedLast24h: 0, p95LatencyMs: 88 },
    createdAt: iso(60 * 24 * 12),
  },
];

const EVENTS: WebhookEvent[] = ['call.completed', 'call.failed', 'transcript.ready', 'compliance.flagged'];

export function webhookDeliveryFixtures(endpointId: string): WebhookDelivery[] {
  const endpoint = webhookEndpointFixtures.find((e) => e.id === endpointId) ?? webhookEndpointFixtures[0]!;
  const events = endpoint.events.length > 0 ? endpoint.events : EVENTS;

  return Array.from({ length: 32 }, (_, i) => {
    const event = events[i % events.length]!;
    const failing = i % 9 === 3;
    const retrying = i % 13 === 5;
    const resourceId = `call_${(918_400 + i * 7).toString(36)}`;
    return {
      id: `whd_${(100_000 + i).toString(36)}`,
      endpointId,
      event,
      resourceId,
      attempt: failing ? endpoint.maxAttempts : retrying ? 2 : 1,
      maxAttempts: endpoint.maxAttempts,
      status: failing ? 'failed' : retrying ? 'retrying' : 'delivered',
      httpStatus: failing ? 503 : retrying ? 500 : 200,
      latencyMs: failing ? 30_000 : 60 + ((i * 37) % 420),
      requestBody: {
        id: `evt_${(500_000 + i).toString(36)}`,
        type: event,
        created_at: iso(i * 17),
        data: {
          call_id: resourceId,
          agent_id: 'agt_support_de',
          outcome: event === 'call.failed' ? 'abandoned' : 'resolved',
          duration_sec: 96 + i,
          median_latency_ms: 340 + ((i * 11) % 90),
        },
      },
      responseBody: failing
        ? '{"error":"upstream timeout"}'
        : retrying
          ? '{"error":"internal"}'
          : '{"ok":true}',
      error: failing ? 'Endpoint returned 503 on all 6 attempts. Delivery abandoned.' : undefined,
      createdAt: iso(i * 17),
      nextRetryAt: retrying ? iso(-4) : undefined,
      replayOfId: i === 1 ? 'whd_2bkq' : undefined,
    } satisfies WebhookDelivery;
  });
}
