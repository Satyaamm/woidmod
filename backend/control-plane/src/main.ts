/**
 * Entrypoint.
 *
 * Real authentication: sessions and API keys resolve through
 * `createPrincipalResolver`. The dev header shortcut is gone — `x-org-slug` was
 * only ever scaffolding, and leaving an unauthenticated bypass in a codebase that
 * claims SOC 2 controls would be indefensible.
 */

import { serve } from '@hono/node-server';

import { config, isProduction, platformSecret } from './config.js';
import { createContainer } from './container.js';
import { createDb, registerShutdown } from './db/client.js';
import { createServer } from './api/index.js';
import { seed } from './seed.js';
import { createPrincipalResolver } from './services/principal-resolver.js';
import { registerProviders } from './providers/registration.js';
import type { FactoryContext, SecretResolver } from './core/patterns/factory.js';




/**
 * Dev secret resolver. Production swaps this for Vault or a cloud KMS — provider
 * factories never read process.env directly, which is what makes that swap a
 * one-line change.
 */
const envSecrets: SecretResolver = {
  async get(name: string) {
    const value = platformSecret(name);
    if (!value) throw new Error(`missing platform secret: ${name}`);
    return value;
  },
};

async function main() {
  // Postgres when DATABASE_URL is set; in-memory otherwise (data does not survive
  // a restart in that mode). The whole account/config repository layer follows this.
  const db = config.DATABASE_URL ? createDb() : undefined;
  const container = createContainer({ db });

  if (db) {
    registerShutdown(db);
    const connected = await db.ping();
    if (!connected) {
      throw new Error(
        `DATABASE_URL is set but Postgres is unreachable at boot — refusing to start on a phantom persistence layer.`,
      );
    }
    container.logger.info('storage', { mode: 'postgres', connected: true });
  } else {
    container.logger.info('storage', { mode: 'in-memory', note: 'data resets on restart' });
  }

  // Load the jurisdiction ruleset before serving, so the first outbound call is
  // decided by the stored rules rather than by the compiled-in fallback. A failure
  // here logs and falls back; it never blocks startup, because a control plane that
  // will not boot is worse than one running on the built-in ruleset.
  await container.services.jurisdictions.refresh(true);

  const factoryContext: FactoryContext = {
    secrets: envSecrets,
    region: config.REGION,
    logger: container.logger,
  };

  // Real adapters register on top of the mocks. Any provider whose credential is
  // absent is skipped with a warning, so a dev box boots on mocks alone.
  const attempted = await registerProviders(container.registries, factoryContext, {
    postures: container.compliance.postures,
  });
  const live = attempted.filter((r) => r.registered);
  container.logger.info('provider startup', {
    // Report what ACTUALLY registered, not what was attempted — a boot log that
    // overstates capability is how you discover in production that every call
    // has been running on mocks.
    live: live.map((r) => r.key),
    skipped: attempted.filter((r) => !r.registered).map((r) => r.key),
    usingMocksOnly: live.length === 0,
  });

  // Development fixtures. Skipped entirely in production.
  if (!isProduction && config.SEED) {
    await seed(container);
  }

  const app = createServer({
    container,
    resolvePrincipal: createPrincipalResolver({
      auth: container.services.auth,
      apiKeys: container.services.apiKeys,
      memberships: container.repositories.memberships,
    }),
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    container.logger.info('control-plane listening', {
      port: info.port,
      region: config.REGION,
      hint: `curl -X POST localhost:${info.port}/auth/signup -H 'content-type: application/json' -d '{"email":"you@example.com","password":"correct-horse-battery"}'`,
    });
  });

  /**
   * Release the port on SIGINT/SIGTERM.
   *
   * `registerShutdown` drains the Postgres pool but nothing closed the listener, so
   * the process outlived its own shutdown signal still holding `:PORT`. Under
   * `tsx watch` that is silent and expensive: the reload spawns a replacement, the
   * replacement dies with EADDRINUSE, and the stale process keeps answering — you
   * edit a file, see no error, and test code that is no longer what you wrote.
   *
   * The timer is the backstop for keep-alive sockets, which `close()` waits on;
   * `unref()` keeps it from holding the process open on its own.
   */
  const closeHttp = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once('SIGINT', closeHttp);
  process.once('SIGTERM', closeHttp);
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
