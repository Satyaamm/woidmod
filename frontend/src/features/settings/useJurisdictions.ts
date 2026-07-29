'use client';

/**
 * The per-country rules the control plane is actually enforcing.
 *
 * Fetched rather than bundled. Since the ruleset moved into the database, counsel
 * can amend a calling window without a deploy — so any table compiled into this
 * bundle is a snapshot that will silently go stale, and a compliance screen that
 * shows stale rules is worse than one that shows none.
 *
 * The local table in `jurisdictions.ts` remains as the offline fallback: if the
 * request fails, the screen renders the build's copy and says so, rather than
 * rendering an empty state that reads like "no rules apply".
 */

import { useCallback, useEffect, useState } from 'react';

import { settingsApi, type JurisdictionRuleset, type LiveJurisdictionRule } from '@/features/settings/api';
import { JURISDICTIONS as FALLBACK_RULES } from '@/features/settings/jurisdictions';

/** The build's copy, shaped like the API's, for the offline path. */
function fallbackRuleset(): JurisdictionRuleset {
  return {
    version: 'bundled',
    builtInFallback: true,
    unreviewedCountries: Object.keys(FALLBACK_RULES),
    items: Object.values(FALLBACK_RULES).map((r) => ({
      country: r.code,
      version: 0,
      reviewedAt: null,
      source: 'bundled with the dashboard',
      consentModel: r.consentModel,
      aiDisclosureRequired: r.aiDisclosureRequired,
      callingWindow: r.callingWindow,
      dncRegistries: r.dncRegistries,
      requireConsentProof: r.requireConsentProof,
      notes: r.notes,
    })),
  };
}

export interface UseJurisdictions {
  ruleset: JurisdictionRuleset;
  byCountry: Record<string, LiveJurisdictionRule>;
  loading: boolean;
  /** Set when the live ruleset could not be fetched — the screen must say so. */
  error: string | null;
  reload: () => void;
}

export function useJurisdictions(workspaceId: string | null): UseJurisdictions {
  const [ruleset, setRuleset] = useState<JurisdictionRuleset>(fallbackRuleset);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setRuleset(await settingsApi.jurisdictions(workspaceId));
      setError(null);
    } catch (err) {
      // Keep the fallback in place: rules on screen, clearly labelled, beats a
      // blank table that reads as "nothing applies".
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const byCountry: Record<string, LiveJurisdictionRule> = {};
  for (const item of ruleset.items) byCountry[item.country.toUpperCase()] = item;

  return { ruleset, byCountry, loading, error, reload: () => void load() };
}
