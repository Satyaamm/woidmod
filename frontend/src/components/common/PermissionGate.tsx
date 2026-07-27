'use client';

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from 'antd';
import type { Permission } from '@/lib/contract';
import { useSessionStore } from '@/stores/session-store';

/**
 * The one place the UI decides whether an action is available.
 *
 * House rule (UI-PAGE-INVENTORY §1): permission-gated items are hidden from
 * *navigation* entirely, but actions *within* a visible page are
 * **disabled-with-a-reason**, never absent and never a button that 403s. A
 * disabled control that explains itself teaches the permission model; a missing
 * one just looks broken.
 *
 *   <PermissionGate need="org:members" reason="Only org admins can invite.">
 *     <Button>Invite</Button>
 *   </PermissionGate>
 *
 * Use `mode="hide"` only for nav entries and whole sections that would be
 * meaningless — never for a primary action.
 */
export function PermissionGate({
  need,
  reason,
  mode = 'disable',
  fallback = null,
  children,
}: {
  /** All of these must be held. */
  need: Permission | Permission[];
  /** Shown in the tooltip when the permission is missing. Say who *can*. */
  reason?: ReactNode;
  mode?: 'disable' | 'hide';
  /** Rendered instead, when `mode="hide"`. */
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const can = useSessionStore((s) => s.can);
  const needed = Array.isArray(need) ? need : [need];
  const allowed = needed.every((p) => can(p));

  if (allowed) return <>{children}</>;
  if (mode === 'hide') return <>{fallback}</>;

  const label = reason ?? `You need the ${needed.join(' + ')} permission for this.`;

  // Disable the child in place so layout does not shift between roles.
  const disabled = isValidElement(children)
    ? cloneElement(children as ReactElement<{ disabled?: boolean }>, { disabled: true })
    : children;

  return (
    <Tooltip title={label}>
      <span style={{ display: 'inline-flex', cursor: 'not-allowed' }}>{disabled}</span>
    </Tooltip>
  );
}

/** Imperative form, for `columns` renderers and other non-JSX positions. */
export function usePermission(need: Permission | Permission[]): boolean {
  const can = useSessionStore((s) => s.can);
  return (Array.isArray(need) ? need : [need]).every((p) => can(p));
}
