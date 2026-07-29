/**
 * v1 API surface.
 *
 * Everything mounted here lives under `/v1` and is authenticated + tenant-scoped
 * by middleware applied in `api/index.ts`. Auth routes are the exception and mount
 * at `/auth`, since you cannot be tenant-scoped before you have authenticated.
 *
 * When v2 arrives it becomes a sibling folder. Both mount side by side, share the
 * same middleware and services, and v1 keeps working — which is the entire reason
 * for versioning the route surface rather than the whole application.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';

import { sessionRoutes } from './session.js';
import { workspaceRoutes } from './workspaces.js';
import { agentRoutes } from './agents.js';
import { platformRoutes } from './platform.js';
import { providerRoutes } from './providers.js';
import { roleRoutes } from './roles.js';
import { sessionVoiceRoutes } from './sessions.js';
import { runtimeRoutes } from './runtime.js';
import { knowledgeRoutes } from './knowledge.js';
import { toolRoutes } from './tools.js';
import { webhookRoutes } from './webhooks.js';
import { evalRoutes } from './evals.js';
import { sipRoutes } from './sip.js';
import { campaignDispatchRoutes } from './campaign-dispatch.js';
import { campaignPreviewRoutes } from './campaign-preview.js';
import { dncListRoutes } from './dnc-lists.js';

export const V1_VERSION = '1.0.0';

/**
 * Routers here use paths RELATIVE to `/v1` — the mount point supplies the prefix.
 * Modules that still declare absolute `/v1/...` paths are registered directly on
 * the root app by `api/index.ts` instead; mounting them here would double the
 * prefix, and re-dispatching to fix that would drop the request-scoped `scope`
 * and `principal` the auth middleware sets.
 */
export function v1Router(container: Container) {
  const v1 = new Hono<ApiEnv>();

  v1.route('/', sessionRoutes(container));
  v1.route('/', workspaceRoutes(container));
  v1.route('/', agentRoutes(container));
  v1.route('/', platformRoutes(container));
  v1.route('/', providerRoutes(container));
  v1.route('/', roleRoutes(container));
  v1.route('/', sessionVoiceRoutes(container));
  v1.route('/', runtimeRoutes(container));
  v1.route('/', sipRoutes(container));
  v1.route('/', campaignDispatchRoutes(container));
  v1.route('/', campaignPreviewRoutes(container));
  v1.route('/', dncListRoutes(container));
  v1.route('/', knowledgeRoutes(container.services.knowledge));
  v1.route('/', toolRoutes(container.services.tools));
  v1.route('/', webhookRoutes(container.services.webhooks));
  v1.route('/', evalRoutes(container.services.evals));

  return v1;
}
