/**
 * v1 — platform metadata, provider health, compliance artefacts.
 *
 * The capabilities endpoint is registry-driven: registering a new provider or
 * strategy makes it appear in the dashboard with no frontend change. That is the
 * payoff for the Registry pattern.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { config } from '../../config.js';
import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { INTERNAL_REGISTRY } from '../../services/dnc.js';
import { REGION_OPTIONS } from '../../services/region.js';
import { requirementsFor, checkEligibility } from '../../compliance/provider-eligibility.js';
import type { AuditAction } from '../../compliance/audit-log.js';

const preflightInput = z.object({
  toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 number required'),
  /** ISO instant to evaluate at. Omitted → now. */
  at: z.string().datetime().optional(),
});

export function platformRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  /**
   * Capabilities, filtered to what THIS workspace may legally use.
   *
   * An EU-pinned workspace must not be offered a US-only vendor, and a
   * HIPAA workspace must not be offered a non-BAA one. Crucially we return the
   * ineligible ones too, WITH a reason — "why can't I pick Deepgram?" has to be
   * answerable in the UI rather than the option silently missing.
   */
  app.get('/capabilities', async (c) => {
    const scope = c.get('scope');
    const { stt, llm, tts, endpointing, bargeIn } = container.registries;

    let eligibility: Array<{ providerKey: string; eligible: boolean; reasons: unknown[] }> = [];
    let configured = new Set<string>();
    if (scope.workspaceId) {
      const ws = await container.services.workspaces.get(scope, scope.workspaceId);
      const req = requirementsFor(ws.region, ws.compliance);
      eligibility = container.compliance.postures.all().map((p) => {
        const result = checkEligibility(p, req);
        return { providerKey: p.key, eligible: result.eligible, reasons: result.reasons };
      });
      // Which vendors this workspace actually holds a key for. The pipeline
      // editor uses it to sort what works to the top and label the rest.
      const credentials = await container.services.providerCredentials.list(scope);
      configured = new Set(credentials.map((cred) => cred.providerKey));
    }

    /**
     * Options are the CATALOG unioned with the registry, not the registry alone.
     *
     * The registry only contains providers whose *platform* credential resolved at
     * boot — which on any BYOK deployment is none of them. Driving the pipeline
     * dropdowns from it meant a customer who had just added their own Cartesia key
     * could not select Cartesia: the only options were the three mocks. That is
     * backwards for a product whose entire premise is bring-your-own-key.
     *
     * So the catalog leads (every vendor a customer may bring), the registry adds
     * anything extra it has (the mocks, and any platform-keyed provider), and each
     * option carries enough state for the UI to be honest about it: `configured`
     * (this workspace holds a key), `runnable` (the worker can execute it) and the
     * eligibility verdict computed above.
     */
    const optionsFor = (
      kind: 'stt' | 'llm' | 'tts',
      registryOptions: Array<{ value: string; label: string; metadata: Record<string, unknown> }>,
    ) => {
      const fromRegistry = new Map(registryOptions.map((o) => [o.value, o]));
      const catalog = container.providerCatalog
        .filter((entry) => entry.kind === kind)
        .map((entry) => ({
          value: entry.key,
          label: entry.label,
          configured: configured.has(entry.key),
          runnable: entry.runnable,
          keyUrl: entry.keyUrl,
          metadata: fromRegistry.get(entry.key)?.metadata ?? {},
        }));

      const seen = new Set(catalog.map((o) => o.value));
      const extras = registryOptions
        .filter((o) => !seen.has(o.value))
        .map((o) => ({
          value: o.value,
          label: o.label,
          // Mocks and platform-keyed providers need no customer credential.
          configured: true,
          runnable: o.value.startsWith('mock-'),
          metadata: o.metadata,
        }));

      return [...catalog, ...extras];
    };

    return c.json({
      stt: optionsFor('stt', stt.options()),
      llm: optionsFor('llm', llm.options()),
      tts: optionsFor('tts', tts.options()),
      endpointing: endpointing.options(),
      bargeIn: bargeIn.options(),
      regions: REGION_OPTIONS,
      eligibility,
    });
  });

  app.get('/providers/health', (c) =>
    c.json({
      stt: container.executors.stt.states(),
      llm: container.executors.llm.states(),
      tts: container.executors.tts.states(),
    }),
  );

  // docs/14 §3 item 7 — customers ask for this during procurement. Generated from
  // the same postures that gate provider selection, so it cannot drift from what
  // the platform actually enforces.
  app.get('/compliance/subprocessors', (c) =>
    c.json({ items: container.compliance.postures.toSubprocessorTable() }),
  );

  /**
   * Which do-not-call registries this deployment can actually screen.
   *
   * The rulesets name registries (`us_national_dnc`, `fr_bloctel`, …) as an
   * obligation; whether anything can *query* one is a deployment fact. Without
   * this the two are indistinguishable in the UI, and a workspace can believe it
   * is screening against a national registry that nothing is wired to — the
   * precise misreading `DncService` reports `unavailable` to prevent.
   *
   * The internal suppression list is always screened and never appears as a gap:
   * it is the org's own data, so it cannot be "not integrated".
   */
  app.get('/compliance/dnc-status', (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:read');

    const ruleset = container.services.jurisdictions.current();
    const required = new Set(
      Object.values(ruleset.rules).flatMap((r) => r.dncRegistries as string[]),
    );
    const configured = new Set(container.services.dnc.configured);
    required.delete(INTERNAL_REGISTRY);

    return c.json({
      /** Registries named by at least one rule that this deployment CAN query. */
      screenable: [...required].filter((r) => configured.has(r)).sort(),
      /** Named by a rule and NOT queryable — every dial to those countries has a gap. */
      unavailable: [...required].filter((r) => !configured.has(r)).sort(),
      /** True when an unscreenable number is refused rather than dialled-and-recorded. */
      unscreenableRefused: config.DNC_REQUIRE_SCREENING,
      internalListScreened: true,
      note:
        'National registries (FTC, Bloctel, TPS) distribute downloadable files under a ' +
        'subscription rather than query APIs, and require a re-scrub at least every 31 days. ' +
        'Configure a commercial lookup via DNC_REGISTRY_PROVIDERS, or load a downloaded ' +
        'snapshot through ListBackedRegistry.',
    });
  });

  /**
   * The per-country ruleset actually in force, with its review provenance.
   *
   * Reads the same value the dispatch gate resolves against, so the dashboard can
   * never show rules the engine isn't using. `reviewedAt: null` is reported rather
   * than hidden — an unreviewed rule that looks authoritative is the failure mode
   * this endpoint exists to prevent.
   */
  app.get('/compliance/jurisdictions', (c) => {
    const ruleset = container.services.jurisdictions.current();
    const items = Object.entries(ruleset.rules)
      .map(([country, rule]) => ({
        country,
        version: rule.version,
        reviewedAt: rule.reviewedAt,
        source: rule.source,
        consentModel: rule.consentModel,
        aiDisclosureRequired: rule.aiDisclosureRequired,
        callingWindow: rule.callingWindow,
        dncRegistries: rule.dncRegistries,
        requireConsentProof: rule.requireConsentProof,
        notes: rule.notes,
      }))
      .sort((a, b) => a.country.localeCompare(b.country));

    return c.json({
      version: ruleset.version,
      // True when the stored ruleset could not be loaded and the compiled-in set is
      // being served — the operator needs to know the difference.
      builtInFallback: container.services.jurisdictions.isFallback,
      unreviewedCountries: items.filter((i) => i.reviewedAt === null).map((i) => i.country),
      items,
    });
  });

  /**
   * "Would this call go through?" — the real gate, evaluated without dialling and
   * without recording.
   *
   * It runs the same chain the dispatcher runs rather than re-implementing the
   * rules for display, which is the only way the answer here and the answer at
   * dial time cannot disagree.
   */
  app.post('/compliance/preflight', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'call:place_test');

    const input = preflightInput.parse(await c.req.json());
    const workspace = await container.services.workspaces.get(scope, scope.workspaceId);

    const decision = await container.services.outboundGuard.check(scope, workspace.compliance, {
      toNumber: input.toNumber,
      decidedBy: scope.userId,
      dryRun: true,
      at: input.at ? new Date(input.at) : undefined,
    });

    return c.json({
      allowed: decision.allowed,
      reason: decision.reason,
      country: decision.destination.country || null,
      countryConfidence: decision.destination.confidence,
      countryNote: decision.destination.note ?? null,
      calleeLocalTime: decision.calleeLocalTime,
      rulesApplied: decision.rulesApplied,
      rule: {
        consentModel: decision.rule.consentModel,
        aiDisclosureRequired: decision.rule.aiDisclosureRequired,
        callingWindows: decision.rule.callingWindows,
        dncRegistries: decision.rule.dncRegistries,
        requireConsentProof: decision.rule.requireConsentProof,
        unknownCountry: decision.rule.unknownCountry,
        reviewedAt: decision.rule.reviewedAt,
        rulesetVersion: decision.rule.rulesetVersion,
        provenance: decision.rule.provenance,
      },
    });
  });

  // SOC 2 CC7.2 / HIPAA §164.312(b).
  app.get('/audit', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:members');
    const params = new URL(c.req.url).searchParams;
    const entries = await container.compliance.audit.listFor(scope, {
      workspaceId: params.get('workspaceId') ?? undefined,
      actorId: params.get('actorId') ?? undefined,
      action: (params.get('action') as AuditAction | null) ?? undefined,
      limit: Number(params.get('limit') ?? 100),
    });
    return c.json({ items: entries });
  });

  /** Proves the hash chain is intact. Auditors ask for this; so do incidents. */
  app.get('/audit/verify', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:members');
    return c.json(await container.compliance.audit.verify(scope.orgId));
  });

  return app;
}
