/**
 * Workspace-level tools — the reusable HTTP calls an agent invokes mid-conversation.
 *
 * `ToolConfig` (agent-embedded) is the shape an agent references by id; `WorkspaceTool`
 * is the shared library record it points at. These schemas are the server-side mirror of
 * the frontend `WorkspaceTool` / `ToolTestResult` contract (frontend/src/lib/contract.ts)
 * — shapes are kept byte-for-byte compatible so the dashboard needs no translation layer.
 *
 * A tool can call any external system, so `secret` header values and the auth secret are
 * stored server-side and only ever leave this process MASKED. That is why `test` runs here
 * and not in the browser (see tool-service.ts).
 */

import { z } from 'zod';

export const toolAuthModeSchema = z.enum(['none', 'bearer', 'api_key', 'basic']);
export type ToolAuthMode = z.infer<typeof toolAuthModeSchema>;

export const toolMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export type ToolMethod = z.infer<typeof toolMethodSchema>;

/** Mirrors the frontend `AgentStatus` union. */
export const agentStatusSchema = z.enum(['draft', 'live', 'paused', 'archived']);

export const toolHeaderSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean(),
});
export type ToolHeader = z.infer<typeof toolHeaderSchema>;

export const toolAuthSchema = z.object({
  mode: toolAuthModeSchema,
  /** Reference to a stored secret, never the secret itself. */
  secretRef: z.string().optional(),
});
export type ToolAuth = z.infer<typeof toolAuthSchema>;

export const toolUsageSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  agentStatus: agentStatusSchema,
});
export type ToolUsage = z.infer<typeof toolUsageSchema>;

/** The persisted record. Matches `WorkspaceTool` in the frontend contract exactly. */
export const workspaceToolSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** snake_case — this is what the LLM sees as the function name. */
  name: z.string(),
  description: z.string(),
  endpoint: z.string(),
  method: toolMethodSchema,
  timeoutMs: z.number(),
  /** JSON Schema (draft 2020-12) object describing the tool's arguments. */
  parameters: z.record(z.unknown()),
  headers: z.array(toolHeaderSchema),
  auth: toolAuthSchema,
  fillerPhrase: z.string().optional(),
  usedBy: z.array(toolUsageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceTool = z.infer<typeof workspaceToolSchema>;

/**
 * Create body. `id`, `workspaceId`, `usedBy` and timestamps are server-assigned, so
 * they are not accepted from the client.
 */
export const createToolInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case (the LLM function name)'),
  description: z.string().min(1).max(1024),
  endpoint: z.string().url(),
  method: toolMethodSchema,
  timeoutMs: z.number().int().min(1).max(30_000).default(8_000),
  parameters: z.record(z.unknown()).default({ type: 'object', properties: {} }),
  headers: z.array(toolHeaderSchema).default([]),
  auth: toolAuthSchema.default({ mode: 'none' }),
  fillerPhrase: z.string().max(280).optional(),
});
export type CreateToolInput = z.infer<typeof createToolInput>;

export const updateToolInput = createToolInput.partial();
export type UpdateToolInput = z.infer<typeof updateToolInput>;

/** Body of `POST /tools/:toolId/test`. */
export const testToolInput = z.object({
  args: z.record(z.unknown()).default({}),
});
export type TestToolInput = z.infer<typeof testToolInput>;

/** Result of executing a tool. Matches `ToolTestResult` in the frontend contract exactly. */
export interface ToolTestResult {
  status: 'ok' | 'error' | 'timeout';
  httpStatus: number | null;
  latencyMs: number;
  request: {
    method: ToolMethod;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    headers: Record<string, string>;
    body: unknown;
  } | null;
  error?: string;
  ranAt: string;
}
