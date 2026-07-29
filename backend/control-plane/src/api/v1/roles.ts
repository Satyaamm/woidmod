/**
 * v1 — role management.
 *
 * The catalog endpoint is what makes a real role editor possible: it returns every
 * permission with a description, risk level, dependencies, and — critically —
 * whether THIS caller may grant it. Rendering a permission the actor cannot grant
 * and failing on save is worse than disabling it with a reason.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { createRoleInput, updateRoleInput } from '../../services/role-service.js';

export function roleRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  /** Permission catalog + built-in role definitions, annotated for this caller. */
  app.get('/roles/catalog', (c) =>
    c.json(container.services.roles.catalog(c.get('scope'))),
  );

  app.get('/roles', async (c) =>
    c.json({ items: await container.services.roles.list(c.get('scope')) }),
  );

  app.get('/roles/:id', async (c) =>
    c.json(await container.services.roles.get(c.get('scope'), c.req.param('id'))),
  );

  app.post('/roles', async (c) => {
    const input = createRoleInput.parse(await c.req.json());
    return c.json(await container.services.roles.create(c.get('scope'), input), 201);
  });

  app.patch('/roles/:id', async (c) => {
    const patch = updateRoleInput.parse(await c.req.json());
    return c.json(
      await container.services.roles.update(c.get('scope'), c.req.param('id'), patch),
    );
  });

  app.delete('/roles/:id', async (c) => {
    await container.services.roles.delete(c.get('scope'), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
