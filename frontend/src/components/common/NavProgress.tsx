'use client';

/**
 * Top-of-viewport progress bar for route transitions. The App Router gives no
 * built-in navigation feedback, so a click on a link that has to compile/load
 * feels dead — users then double-click and fire duplicate work. This bar starts
 * the instant an internal link is clicked and completes when the pathname
 * actually changes, so every navigation reads as "working…".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { theme } from 'antd';

export function NavProgress() {
  const { token } = theme.useToken();
  const pathname = usePathname();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  // Creep toward 90% while we wait, never reaching it — the real completion
  // comes from the pathname change below.
  const trickle = useCallback(() => {
    setWidth((w) => {
      if (w >= 90) return w;
      timers.current.push(setTimeout(trickle, 250));
      return w + Math.max(0.5, (92 - w) * 0.08);
    });
  }, []);

  const finish = useCallback(() => {
    clearTimers();
    setWidth(100);
    timers.current.push(
      setTimeout(() => {
        setActive(false);
        setWidth(0);
      }, 250),
    );
  }, [clearTimers]);

  const start = useCallback(() => {
    clearTimers();
    setActive(true);
    setWidth(8);
    timers.current.push(setTimeout(trickle, 100));
    // Safety net: if the click didn't actually navigate, don't hang forever.
    timers.current.push(setTimeout(finish, 8000));
  }, [clearTimers, trickle, finish]);

  // Start on any left-click that resolves to a same-origin, different-path link.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      const target = anchor.getAttribute('target');
      if (!href || href.startsWith('#') || (target && target !== '_self') || anchor.hasAttribute('download')) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      start();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [start]);

  // Complete when the route actually changed (skip the initial mount).
  const seen = useRef(pathname);
  useEffect(() => {
    if (seen.current === pathname) return;
    seen.current = pathname;
    if (active) finish();
  }, [pathname, active, finish]);

  useEffect(() => clearTimers, [clearTimers]);

  if (!active && width === 0) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 2000,
        height: 2.5,
        width: `${width}%`,
        background: token.colorPrimary,
        boxShadow: `0 0 10px ${token.colorPrimary}, 0 0 4px ${token.colorPrimary}`,
        borderRadius: '0 2px 2px 0',
        transition: 'width 0.25s ease',
        pointerEvents: 'none',
      }}
    />
  );
}
