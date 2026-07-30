/**
 * v1 — bring-your-own-key provider credentials.
 *
 * Secrets go in and are never readable again: `POST` accepts them, everything else
 * returns a view with `secretHints` only. There is deliberately no "reveal" endpoint
 * — if a customer loses their key, they rotate it at the vendor, not here.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { requireWorkspace } from '../../domain/tenant.js';
import {
  createCredentialInput,
  type ProviderKind,
} from '../../services/provider-credentials.js';
import { z } from 'zod';

const rotateInput = z.object({ secrets: z.record(z.string().min(1)) });

/** Unsaved credentials to probe. Same shape as create, minus the naming/scoping. */
const testCredentialInput = z.object({
  providerKey: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  secrets: z.record(z.string()),
});

export function providerRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  /** Every configured credential, secrets stripped. */
  app.get('/provider-credentials', async (c) => {
    const scope = c.get('scope');
    const kind = new URL(c.req.url).searchParams.get('kind') as ProviderKind | null;
    return c.json({
      items: await container.services.providerCredentials.list(scope, kind ?? undefined),
    });
  });

  app.post('/provider-credentials', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createCredentialInput.parse(await c.req.json());
    return c.json(await container.services.providerCredentials.create(scope, input), 201);
  });

  /** Rotate secret fields in place, keeping the credential's identity and config. */
  /** Edit routing config in place (region, endpoint, deployment name…). */
  app.patch('/provider-credentials/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = z.object({ config: z.record(z.string()) }).parse(await c.req.json());
    return c.json(await container.services.providerCredentials.updateConfig(scope, c.req.param('id'), body.config));
  });

  app.post('/provider-credentials/:id/rotate', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const { secrets } = rotateInput.parse(await c.req.json());
    return c.json(
      await container.services.providerCredentials.rotate(scope, c.req.param('id'), secrets),
    );
  });

  /**
   * Verify a stored credential actually works — a real authenticated call to the
   * vendor, not a field check.
   *
   * Customers need to know a key is live *before* it fails on a real call, and a
   * rotated key is marked `unverified` until this passes.
   */
  app.post('/provider-credentials/:id/verify', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const id = c.req.param('id');
    const result = await container.services.providerCredentials.verify(scope, id);
    return c.json(result);
  });

  /**
   * Test credentials that have NOT been saved — the "Test connection" button in
   * the add/rotate form.
   *
   * Deliberately not under `/:id`: there is no id yet. Secrets are used for the
   * one probe and never written, which is the whole point — a customer finds out
   * their Azure deployment name is wrong while the form is still open, rather
   * than on a call.
   */
  app.post('/provider-credentials/test', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = testCredentialInput.parse(await c.req.json());
    return c.json(await container.services.providerCredentials.test(scope, input));
  });

  app.delete('/provider-credentials/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await container.services.providerCredentials.delete(scope, c.req.param('id'));
    return c.body(null, 204);
  });

  /**
   * What a customer *could* configure: every registered adapter with the config and
   * secret fields it needs, so the dashboard can render a credential form without
   * hardcoding one per vendor.
   */
  app.get('/provider-catalog', (c) => {
    return c.json({ items: container.providerCatalog });
  });

  return app;
}
