/**
 * Development seed data.
 *
 * Deliberately goes through the REAL signup path rather than inserting rows
 * directly. Two reasons:
 *
 *  1. It exercises the auto-provisioning flow on every boot — if the "under 60
 *     seconds to a conversation" journey (docs/11 §A) breaks, the server fails to
 *     start rather than failing silently for the first real user.
 *  2. Seeded data is then indistinguishable from real data, so nothing works in
 *     dev because of a fixture shortcut that production won't have.
 *
 * Seeds a DE org and a US org so residency and compliance divergence is visible
 * from the dashboard immediately.
 */

import type { Container } from './container.js';

export interface SeedResult {
  accounts: Array<{
    email: string;
    orgSlug: string;
    workspaceId: string;
    agentId: string;
    sessionToken: string;
  }>;
}

// Neutral placeholder domains — no invented brand names anywhere in the product.
// Two distinct domains, not one: the org name and slug are DERIVED from the domain
// by the real signup path, so a shared domain would make both seeded orgs collide
// on the same name and only differ by a slug suffix.
const ACCOUNTS = [
  { email: 'first.user@demo-eu.example', country: 'DE', timezone: 'Europe/Berlin', locale: 'de-DE' },
  { email: 'second.user@demo-us.example', country: 'US', timezone: 'America/New_York', locale: 'en-US' },
];

export async function seed(c: Container): Promise<SeedResult> {
  const accounts: SeedResult['accounts'] = [];

  for (const spec of ACCOUNTS) {
    // Idempotent: with Postgres the seed runs on every boot, so an account seeded
    // last time must not collide. In-memory starts empty, so this is a no-op there.
    const existing = await c.repositories.users.findByEmail(spec.email);
    if (existing) {
      c.logger.info('seed account already present, skipping', { email: spec.email });
      continue;
    }

    const result = await c.services.auth.signup({
      email: spec.email,
      password: 'dev-password-not-for-production',
      country: spec.country,
      timezone: spec.timezone,
      locale: spec.locale,
    });

    accounts.push({
      email: spec.email,
      orgSlug: result.organization.slug,
      workspaceId: result.workspace.id,
      agentId: result.agent.id,
      sessionToken: result.session.token,
    });

    // Log the compliance posture that was DERIVED, not configured. If these
    // values ever stop diverging by country, the defaults have regressed.
    c.logger.info('seeded account', {
      org: result.organization.slug,
      country: spec.country,
      region: result.workspace.region,
      consentModel: result.workspace.compliance.consentModel,
      retentionDays: result.workspace.compliance.retentionDays,
      requireConsentProof: result.workspace.compliance.requireConsentProof,
      aiDisclosure: result.workspace.compliance.aiDisclosureRequired,
      agent: result.agent.name,
      language: result.agent.language,
    });
  }

  return { accounts };
}
