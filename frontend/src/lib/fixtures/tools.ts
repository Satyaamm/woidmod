/** ⚠️ LOCAL FIXTURES — see ./index.ts. Workspace-level reusable tools. */
import type { ToolTestResult, WorkspaceTool } from '@/lib/contract';

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

export const workspaceToolFixtures: WorkspaceTool[] = [
  {
    id: 'tool_lookup_customer',
    workspaceId: 'ws_fixture',
    name: 'lookup_customer',
    description:
      'Look up a customer by their phone number or customer ID. Call this before discussing anything account-specific.',
    endpoint: 'https://api.example.com/v2/customers/lookup',
    method: 'POST',
    timeoutMs: 2_500,
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Caller number in E.164, e.g. +4915112345678' },
        customer_id: { type: 'string', description: 'Customer ID if the caller reads one out' },
      },
      required: ['phone'],
      additionalProperties: false,
    },
    headers: [{ key: 'X-Tenant-Id', value: 'eu-prod', secret: false }],
    auth: { mode: 'bearer', secretRef: 'sec_api_token' },
    fillerPhrase: 'One moment, I am pulling up your account.',
    usedBy: [
      { agentId: 'agt_support_de', agentName: 'Support DE', agentStatus: 'live' },
      { agentId: 'agt_support_en', agentName: 'Support EN', agentStatus: 'live' },
    ],
    createdAt: iso(71),
    updatedAt: iso(9),
  },
  {
    id: 'tool_book_appointment',
    workspaceId: 'ws_fixture',
    name: 'book_appointment',
    description:
      'Book a technician appointment in a two-hour window. Only call once the customer has confirmed both the date and the window.',
    endpoint: 'https://api.example.com/v2/appointments',
    method: 'POST',
    timeoutMs: 4_000,
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'From lookup_customer' },
        date: { type: 'string', description: 'ISO date, YYYY-MM-DD' },
        window: { type: 'string', enum: ['08-10', '10-12', '12-14', '14-16', '16-18'] },
        reason: { type: 'string', description: 'Short free-text reason for the visit' },
      },
      required: ['customer_id', 'date', 'window'],
      additionalProperties: false,
    },
    headers: [],
    auth: { mode: 'bearer', secretRef: 'sec_api_token' },
    fillerPhrase: 'Let me check that slot for you.',
    usedBy: [{ agentId: 'agt_support_de', agentName: 'Support DE', agentStatus: 'live' }],
    createdAt: iso(58),
    updatedAt: iso(4),
  },
  {
    id: 'tool_create_refund_request',
    workspaceId: 'ws_fixture',
    name: 'create_refund_request',
    description:
      'Log a refund request for back-office review. Never tell the caller the refund is approved — it is only a request.',
    endpoint: 'https://api.example.com/v2/refunds/requests',
    method: 'POST',
    timeoutMs: 3_000,
    parameters: {
      type: 'object',
      properties: {
        invoice_number: { type: 'string' },
        amount_eur: { type: 'number', description: 'Disputed amount in euros' },
        reason_code: { type: 'string', enum: ['double_charge', 'service_not_used', 'price_dispute', 'other'] },
      },
      required: ['invoice_number', 'reason_code'],
      additionalProperties: false,
    },
    headers: [],
    auth: { mode: 'bearer', secretRef: 'sec_api_token' },
    usedBy: [],
    createdAt: iso(30),
    updatedAt: iso(30),
  },
  {
    id: 'tool_check_order_status',
    workspaceId: 'ws_fixture',
    name: 'check_order_status',
    description: 'Return the delivery status of an order by order number.',
    endpoint: 'https://api.example.com/v2/orders/{order_number}',
    method: 'GET',
    timeoutMs: 2_000,
    parameters: {
      type: 'object',
      properties: { order_number: { type: 'string', description: 'e.g. ACM-8842119' } },
      required: ['order_number'],
      additionalProperties: false,
    },
    headers: [],
    auth: { mode: 'api_key', secretRef: 'sec_orders_key' },
    usedBy: [{ agentId: 'agt_sales', agentName: 'Sales qualifier', agentStatus: 'draft' }],
    createdAt: iso(22),
    updatedAt: iso(15),
  },
];

export function toolTestFixture(tool: WorkspaceTool, args: Record<string, unknown>): ToolTestResult {
  const url = tool.endpoint.replace(/\{(\w+)\}/g, (_, k: string) => String(args[k] ?? `{${k}}`));
  const latencyMs = 120 + (JSON.stringify(args).length % 400);
  const missing = ((tool.parameters as { required?: string[] }).required ?? []).filter(
    (k) => args[k] === undefined || args[k] === '',
  );

  const request = {
    method: tool.method,
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(tool.auth.mode === 'bearer' ? { Authorization: 'Bearer ••••••••' } : {}),
      ...Object.fromEntries(tool.headers.map((h) => [h.key, h.secret ? '••••••••' : h.value])),
    },
    body: tool.method === 'GET' ? null : args,
  } as const;

  if (missing.length > 0) {
    return {
      status: 'error',
      httpStatus: 400,
      latencyMs: 41,
      request,
      response: {
        headers: { 'content-type': 'application/json' },
        body: { error: 'missing_required_parameter', missing },
      },
      error: `Required parameter${missing.length > 1 ? 's' : ''} not supplied: ${missing.join(', ')}`,
      ranAt: new Date().toISOString(),
    };
  }

  return {
    status: 'ok',
    httpStatus: 200,
    latencyMs,
    request,
    response: {
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_fixture_8f21' },
      body:
        tool.name === 'lookup_customer'
          ? { customer_id: 'cus_9931', name: 'K. Brandt', tariff: 'Premium', balance_eur: 0, vulnerable: false }
          : tool.name === 'book_appointment'
            ? { appointment_id: 'apt_5512', confirmed: true, date: args.date, window: args.window }
            : tool.name === 'check_order_status'
              ? { order_number: args.order_number, status: 'in_transit', eta: '2026-07-25' }
              : { request_id: 'rfr_3310', status: 'pending_review' },
    },
    ranAt: new Date().toISOString(),
  };
}
