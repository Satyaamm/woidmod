'use client';

/**
 * URL-state helpers for the org screens.
 *
 * House rule: **tabs and filters live in the URL, never in `useState` and never
 * in a store.** A bug report that says "the members tab shows the wrong role"
 * has to arrive as a link that reproduces it, and a filtered audit view has to
 * survive a refresh and a paste into Slack. `useState` gives you neither.
 */
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useParams } from 'next/navigation';

/** The org slug from the route. The URL owns scope (docs/10 §Scoping rules 3). */
export function useOrgSlug(): string {
  const params = useParams<{ orgSlug?: string }>();
  return params?.orgSlug ?? '';
}

/**
 * Read/write a single query param, replacing history so tab-flipping does not
 * bury the back button under twelve entries.
 */
export function useQueryState(key: string, fallback = '') {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const value = search?.get(key) ?? fallback;

  const set = useCallback(
    (next: string | undefined, { push = false }: { push?: boolean } = {}) => {
      const params = new URLSearchParams(search?.toString());
      if (!next || next === fallback) params.delete(key);
      else params.set(key, next);
      const qs = params.toString();
      const href = qs ? `${pathname}?${qs}` : pathname;
      if (push) router.push(href);
      else router.replace(href);
    },
    [key, fallback, pathname, router, search],
  );

  return [value, set] as const;
}

/** Bulk filter state: many params, one setter, empty values removed. */
export function useQueryFilters<T extends Record<string, string | undefined>>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const values = useMemo(() => {
    const out = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const v = search?.get(key);
      if (v != null) (out as Record<string, string | undefined>)[key] = v;
    }
    return out;
  }, [search, defaults]);

  const setFilters = useCallback(
    (patch: Partial<T>) => {
      const params = new URLSearchParams(search?.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '' || value === null) params.delete(key);
        else params.set(key, String(value));
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router, search],
  );

  const clear = useCallback(() => router.replace(pathname), [pathname, router]);

  const activeCount = useMemo(
    () => Object.entries(values).filter(([k, v]) => v && v !== defaults[k]).length,
    [values, defaults],
  );

  return { values, setFilters, clear, activeCount };
}
