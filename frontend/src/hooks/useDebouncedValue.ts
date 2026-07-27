'use client';

import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only updates after it has stopped changing for
 * `delayMs`. The one debounce primitive for the whole product, so no list page
 * invents its own timer bookkeeping (used by SearchInput and usePaginated).
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
