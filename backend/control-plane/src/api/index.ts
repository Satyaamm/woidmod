/**
 * Application factory.
 *
 * Assembly order matters and is deliberate:
 *
 *   1. CORS + error handler        — apply to everything, including 401s
 *   2. Unversioned operational routes (/health) — must work without auth
 *   3. /auth/*                     — UNauthenticated by definition
 *   4. tenantContext on /v1/*      — everything past here is authorized
 *   5. v1 routes
 *
 * Getting 3 and 4 the wrong way round would make signup require a session.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Container } from '../container.js';
import {
  errorHandler,
  tenantContext,
  versionHeader,
  type ApiEnv,
  type PrincipalResolver,
} from './middleware/index.js';
import { v1Router, V1_VERSION } from './v1/index.js';

// Route modules still using the `register(app, container)` shape with absolute
// `/v1/...` paths. They mount on the root app, after the /v1 middleware, so they
// are authorized exactly like the versioned routers.
import { registerAuthRoutes } from './routes/auth.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerTelephonyRoutes } from './routes/telephony.js';
import { config } from '../config.js';
import { SipService } from '../services/sip.js';

export interface ServerDeps {
  container: Container;
  /**
   * Resolves a request to a Principal — session cookie/bearer token, or API key.
   * The single seam where authentication is implemented; routes never see it.
   */
  resolvePrincipal: PrincipalResolver;
}

export function createServer({ container, resolvePrincipal }: ServerDeps) {
  const app = new Hono<ApiEnv>();

  app.use('*', cors({ origin: (o) => o ?? '*', credentials: true }));
  app.use('*', versionHeader(V1_VERSION));
  app.onError(errorHandler(container));

  // Unversioned: liveness must not depend on the API surface or on auth.
  app.get('/health', (c) =>
    c.json({ ok: true, service: 'control-plane', apiVersion: V1_VERSION }),
  );

  // Public inbound TwiML — Twilio fetches this when a bought number rings. It forwards
  // the PSTN call to LiveKit SIP, where the dispatch rule drops it into a room with the
  // agent. Unauthenticated by necessity (the carrier calls it); it returns no secrets.
  const twiml = () => SipService.inboundTwiml(config.LIVEKIT_SIP_URI);
  app.get('/telephony/twiml/inbound', (c) => c.body(twiml(), 200, { 'content-type': 'text/xml' }));
  app.post('/telephony/twiml/inbound', (c) => c.body(twiml(), 200, { 'content-type': 'text/xml' }));

  // Tenant context guards EVERY `/v1/*` route. Registered BEFORE any route module
  // because Hono only runs middleware for routes declared after it — and `auth.ts`
  // declares both `/auth/*` (unauthenticated) AND `/v1/*` (members, invitations,
  // org, me) in one module. Path-scoped to `/v1/*`, so `/auth/*` stays public.
  app.use('/v1/*', tenantContext(resolvePrincipal));

  // `/auth/*` is unauthenticated by design — this is where sessions are created.
  // Its `/v1/*` routes now correctly inherit the middleware above.
  registerAuthRoutes(app as never, container as never);

  app.route('/v1', v1Router(container));

  // Absolute-path modules, mounted after the middleware above so they inherit it.
  registerCallRoutes(app as never, container as never);
  registerTelephonyRoutes(app as never, container as never);

  return app;
}

export type { ApiEnv, Vars } from './middleware/index.js';
