'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/** Order-insensitive structural comparison — good enough for settings payloads. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Per-section draft state.
 *
 * Each settings card holds its own copy of the slice it owns, so saving one
 * section can never commit a half-finished edit in another (docs UI-IA §5:
 * "save per section, never one giant Save").
 */
export function useDraft<T extends object>(committed: T) {
  const [draft, setDraft] = useState<T>(committed);

  // Re-sync when the server value changes underneath us (another section saved,
  // and the PATCH response replaced the whole workspace).
  useEffect(() => {
    setDraft(committed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(committed)]);

  const patch = useCallback(
    (partial: Partial<T>) => setDraft((prev) => ({ ...prev, ...partial })),
    [],
  );

  const reset = useCallback(() => setDraft(committed), [committed]);

  const dirty = useMemo(() => !equal(draft, committed), [draft, committed]);

  return { draft, setDraft, patch, reset, dirty };
}
