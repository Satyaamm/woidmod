'use client';

/**
 * Shared helpers for the RBAC editor.
 *
 * A permission is never granted in isolation: `provider:manage` is meaningless
 * without `provider:read`. The catalog encodes those edges in `requires`, and
 * the editor must keep the selection *closed* under them — checking a permission
 * pulls in its dependencies, and a dependency cannot be dropped while something
 * that needs it is still checked. Computing the closure in one place keeps the
 * checkbox UI and the submit payload from ever disagreeing.
 */
import type { Permission, PermissionDefinition, PermissionRisk } from '@/lib/contract';

/** antd Tag preset colour per risk level. Higher risk reads hotter. */
export const RISK_COLOR: Record<PermissionRisk, string> = {
  low: 'green',
  medium: 'gold',
  high: 'orange',
  critical: 'red',
};

export const RISK_LABEL: Record<PermissionRisk, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export type PermissionDef = PermissionDefinition & { grantable: boolean };

/**
 * Grow a selection to include every permission its members `require`, transitively.
 * Idempotent: closing an already-closed set returns the same members.
 */
export function closeOverRequires(
  selected: Iterable<Permission>,
  defs: Map<Permission, PermissionDef>,
): Set<Permission> {
  const out = new Set<Permission>(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of Array.from(out)) {
      for (const req of defs.get(p)?.requires ?? []) {
        if (!out.has(req)) {
          out.add(req);
          changed = true;
        }
      }
    }
  }
  return out;
}
