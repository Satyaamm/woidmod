'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Filters belong in the query string (UI-IA §2) — but pushing a route change on
 * every keystroke re-renders the page and drops focus out of the input. Type
 * locally, publish on a pause.
 */
export function useDebouncedText(
  external: string,
  publish: (value: string) => void,
  delayMs = 300,
): [string, (value: string) => void] {
  const [local, setLocal] = useState(external);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishRef = useRef(publish);
  publishRef.current = publish;

  // Re-sync when the URL changes from somewhere else (back button, pasted link).
  useEffect(() => {
    setLocal((current) => (current === external ? current : external));
  }, [external]);

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  const set = (value: string) => {
    setLocal(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => publishRef.current(value), delayMs);
  };

  return [local, set];
}
