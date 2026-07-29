/**
 * Workspace tool management + live test execution.
 *
 * Two responsibilities:
 *   1. CRUD over the reusable tool library, workspace-scoped and permission-gated
 *      (`tool:read` to view, `tool:write` to change). Deleting a tool an agent still
 *      references is refused with a `ConflictError` — the same 409 the dashboard
 *      surfaces as "used by 2 agents".
 *   2. `test()` — actually executes the tool server-side against its configured
 *      endpoint, applying the stored auth secret. This runs here, never in the
 *      browser, so the workspace's secrets are used but never shipped to the client:
 *      the request echoed back in the result has every secret MASKED.
 *
 * The executor fails closed: a tight abort timeout guarantees a hung upstream can
 * never wedge the process, and every error/timeout is mapped to a structured
 * `ToolTestResult` rather than thrown.
 */

import { newId } from '../domain/ids.js';
import { require_ } from '../domain/tenant.js';
import type { WorkspaceScope } from '../domain/tenant.js';
import { ConflictError, NotFoundError } from '../repositories/types.js';
import {
  createToolInput,
  updateToolInput,
  type CreateToolInput,
  type UpdateToolInput,
  type TestToolInput,
  type ToolTestResult,
  type WorkspaceTool,
} from '../domain/tool-schemas.js';

/** Hard ceiling on a single test call, regardless of the tool's configured timeout. */
const MAX_TEST_TIMEOUT_MS = 8_000;
/** Response bodies larger than this are truncated before being returned to the client. */
const MAX_RESPONSE_BYTES = 16_000;
const MASK = '••••••••';

/**
 * Resolves a stored secret reference to its plaintext value, server-side only.
 * The default reads from the process environment; a real deployment swaps in the
 * KMS/secret-manager-backed implementation. The resolved value is used to build the
 * outbound request and is NEVER placed in the returned `ToolTestResult`.
 */
export interface SecretResolver {
  resolve(scope: WorkspaceScope, secretRef: string): string | undefined;
}

const envSecretResolver: SecretResolver = {
  resolve(_scope, secretRef) {
    return process.env[secretRef] ?? process.env[secretRef.toUpperCase()];
  },
};

export interface ToolRepository {
  list(scope: WorkspaceScope): Promise<WorkspaceTool[]>;
  get(scope: WorkspaceScope, id: string): Promise<WorkspaceTool | null>;
  create(scope: WorkspaceScope, tool: WorkspaceTool): Promise<WorkspaceTool>;
  update(scope: WorkspaceScope, id: string, patch: Partial<WorkspaceTool>): Promise<WorkspaceTool>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
}

/** Injectable for tests; defaults to the platform `fetch`. */
export type FetchFn = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

export class ToolService {
  constructor(
    private readonly repo: ToolRepository,
    private readonly secrets: SecretResolver = envSecretResolver,
    private readonly fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {}

  async list(scope: WorkspaceScope): Promise<WorkspaceTool[]> {
    require_(scope, 'tool:read');
    return this.repo.list(scope);
  }

  async get(scope: WorkspaceScope, id: string): Promise<WorkspaceTool> {
    require_(scope, 'tool:read');
    const tool = await this.repo.get(scope, id);
    if (!tool) throw new NotFoundError('tool', id);
    return tool;
  }

  async create(scope: WorkspaceScope, input: CreateToolInput): Promise<WorkspaceTool> {
    require_(scope, 'tool:write');
    const parsed = createToolInput.parse(input);
    const now = new Date().toISOString();
    const tool: WorkspaceTool = {
      id: newId('tool'),
      workspaceId: scope.workspaceId,
      ...parsed,
      usedBy: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.repo.create(scope, tool);
  }

  async update(scope: WorkspaceScope, id: string, patch: UpdateToolInput): Promise<WorkspaceTool> {
    require_(scope, 'tool:write');
    await this.get(scope, id); // 404s if it doesn't exist / isn't in this workspace
    const parsed = updateToolInput.parse(patch);
    return this.repo.update(scope, id, { ...parsed, updatedAt: new Date().toISOString() });
  }

  async remove(scope: WorkspaceScope, id: string): Promise<void> {
    require_(scope, 'tool:write');
    const existing = await this.get(scope, id);
    // A tool an agent still references cannot be deleted — pulling it would leave a
    // live agent with a dangling tool call. The dashboard renders this 409 as the
    // "used by N agents" block.
    if (existing.usedBy.length > 0) {
      const names = existing.usedBy.map((u) => u.agentName).join(', ');
      throw new ConflictError(
        `"${existing.name}" is used by ${existing.usedBy.length} agent(s) (${names}) — detach it there first`,
      );
    }
    await this.repo.delete(scope, id);
  }

  /**
   * Execute the tool for real and return a structured trace. Reading requires
   * `tool:write`: a test issues a genuine outbound call that can mutate an external
   * system (a refund request, an appointment booking), so it is gated the same as
   * editing the tool, not merely viewing it.
   */
  async test(scope: WorkspaceScope, id: string, input: TestToolInput): Promise<ToolTestResult> {
    require_(scope, 'tool:write');
    const tool = await this.get(scope, id);
    const args = input.args ?? {};
    const ranAt = new Date().toISOString();

    // Path templating: {param} in the endpoint is filled from args and consumes it,
    // so it is not also sent as a query param / body field.
    const consumed = new Set<string>();
    const basePath = tool.endpoint.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const value = args[key];
      if (value === undefined) return `{${key}}`;
      consumed.add(key);
      return encodeURIComponent(String(value));
    });

    const remaining: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!consumed.has(k)) remaining[k] = v;
    }

    const bodyless = tool.method === 'GET' || tool.method === 'DELETE';

    // Query string for bodyless methods; the rest travels as a JSON body.
    let url = basePath;
    if (bodyless) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(remaining)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const query = qs.toString();
      if (query) url += (url.includes('?') ? '&' : '?') + query;
    }

    const { real, masked } = this.buildHeaders(scope, tool);
    const requestBody = bodyless ? null : remaining;
    const request = {
      method: tool.method,
      url,
      headers: masked,
      body: requestBody,
    };

    // Precheck required params before spending a network round-trip on a call that
    // the upstream would reject anyway.
    const required = Array.isArray((tool.parameters as { required?: unknown }).required)
      ? ((tool.parameters as { required?: string[] }).required ?? [])
      : [];
    const missing = required.filter((k) => args[k] === undefined || args[k] === '');
    if (missing.length > 0) {
      return {
        status: 'error',
        httpStatus: 400,
        latencyMs: 0,
        request,
        response: {
          headers: { 'content-type': 'application/json' },
          body: { error: 'missing_required_parameter', missing },
        },
        error: `Required parameter${missing.length > 1 ? 's' : ''} not supplied: ${missing.join(', ')}`,
        ranAt,
      };
    }

    const timeoutMs = Math.min(Math.max(tool.timeoutMs || MAX_TEST_TIMEOUT_MS, 1), MAX_TEST_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();

    try {
      const res = await this.fetchFn(url, {
        method: tool.method,
        headers: real,
        body: bodyless ? undefined : JSON.stringify(remaining),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;

      const raw = await res.text();
      const truncated =
        raw.length > MAX_RESPONSE_BYTES
          ? `${raw.slice(0, MAX_RESPONSE_BYTES)}…[truncated ${raw.length - MAX_RESPONSE_BYTES} bytes]`
          : raw;

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: res.ok ? 'ok' : 'error',
        httpStatus: res.status,
        latencyMs,
        request,
        response: { headers: responseHeaders, body: parseBody(truncated) },
        error: res.ok ? undefined : `HTTP ${res.status}`,
        ranAt,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const aborted =
        controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      return {
        status: aborted ? 'timeout' : 'error',
        httpStatus: null,
        latencyMs,
        request,
        response: null,
        error: aborted
          ? `Request exceeded the ${timeoutMs}ms timeout`
          : err instanceof Error
            ? err.message
            : String(err),
        ranAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Two header maps: `real` carries resolved secrets for the outbound request, `masked`
   * is what we echo back to the client. They differ only in secret values.
   */
  private buildHeaders(
    scope: WorkspaceScope,
    tool: WorkspaceTool,
  ): { real: Record<string, string>; masked: Record<string, string> } {
    const real: Record<string, string> = { 'Content-Type': 'application/json' };
    const masked: Record<string, string> = { 'Content-Type': 'application/json' };

    const secret = tool.auth.secretRef
      ? (this.secrets.resolve(scope, tool.auth.secretRef) ?? '')
      : '';

    switch (tool.auth.mode) {
      case 'bearer':
        real.Authorization = `Bearer ${secret}`;
        masked.Authorization = `Bearer ${MASK}`;
        break;
      case 'api_key':
        real['X-API-Key'] = secret;
        masked['X-API-Key'] = MASK;
        break;
      case 'basic':
        real.Authorization = `Basic ${secret}`;
        masked.Authorization = `Basic ${MASK}`;
        break;
      case 'none':
        break;
    }

    for (const h of tool.headers) {
      real[h.key] = h.value;
      masked[h.key] = h.secret ? MASK : h.value;
    }

    return { real, masked };
  }
}

function parseBody(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------

export class MemoryToolRepository implements ToolRepository {
  private readonly rows = new Map<string, WorkspaceTool>();

  private scoped(scope: WorkspaceScope): WorkspaceTool[] {
    return [...this.rows.values()].filter((t) => t.workspaceId === scope.workspaceId);
  }

  async list(scope: WorkspaceScope): Promise<WorkspaceTool[]> {
    return this.scoped(scope).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(scope: WorkspaceScope, id: string): Promise<WorkspaceTool | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === scope.workspaceId ? row : null;
  }

  async create(scope: WorkspaceScope, tool: WorkspaceTool): Promise<WorkspaceTool> {
    const row = { ...tool, workspaceId: scope.workspaceId };
    this.rows.set(row.id, row);
    return row;
  }

  async update(
    scope: WorkspaceScope,
    id: string,
    patch: Partial<WorkspaceTool>,
  ): Promise<WorkspaceTool> {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('tool', id);
    const next: WorkspaceTool = {
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId: existing.workspaceId,
      createdAt: existing.createdAt,
    };
    this.rows.set(id, next);
    return next;
  }

  async delete(scope: WorkspaceScope, id: string): Promise<void> {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('tool', id);
    this.rows.delete(id);
  }
}

/** Factory — in-memory repo + env-backed secret resolver + platform fetch. */
export function createToolService(): ToolService {
  return new ToolService(new MemoryToolRepository());
}
