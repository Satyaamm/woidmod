/**
 * Reserved slugs — routing-collision prevention.
 *
 * URLs are `/orgs/[orgSlug]/[workspaceSlug]/...`, which means a workspace slug sits
 * in the same path position as any future org-level route. Without a denylist,
 * `/orgs/your-org/settings` is ambiguous: org settings page, or a workspace literally
 * named "settings"?
 *
 * The alternative designs were an extra path segment (`/orgs/your-org/w/production/…`)
 * or a sentinel (`/orgs/your-org/~/settings`). We chose reserved words because the URLs
 * stay short and we already validate slugs at creation — but that choice only holds
 * if the list is generous NOW, while there are no customers. Adding an org-level
 * route later that collides with an existing workspace slug is a migration, not a
 * deploy.
 *
 * **When adding a new org-level or top-level route, add its segment here first.**
 */

/**
 * Segments that may appear directly under `/orgs/[orgSlug]/`, and therefore cannot
 * be workspace slugs. Includes routes we have, routes we've planned, and a margin
 * of obvious future ones.
 */
const ORG_LEVEL_ROUTES = [
  // Built or planned org-level screens
  'settings', 'members', 'people', 'team', 'teams', 'billing', 'invoices',
  'usage', 'audit', 'logs', 'workspaces', 'projects', 'compliance', 'security',
  'integrations', 'keys', 'api-keys', 'sso', 'roles', 'permissions',
  // Lifecycle / actions that could sit at this level
  'new', 'create', 'edit', 'delete', 'invite', 'invitations', 'onboarding',
  'upgrade', 'plans', 'subscription', 'checkout',
  // Disambiguators reserved so we can adopt them later without a migration
  'w', 'ws', 'workspace', 'org', 'orgs', '~', '_',
] as const;

/**
 * Segments that appear at the application root, and therefore cannot be org slugs.
 */
const TOP_LEVEL_ROUTES = [
  'orgs', 'org', 'account', 'accounts', 'profile', 'user', 'users',
  'login', 'logout', 'signup', 'signin', 'signout', 'register',
  'auth', 'oauth', 'sso', 'verify', 'verify-email', 'forgot-password',
  'reset-password', 'invite', 'accept-invite',
  'api', 'v1', 'v2', 'graphql', 'webhook', 'webhooks', 'health', 'status',
  'admin', 'internal', 'system', 'static', 'assets', 'public', '_next',
  'docs', 'documentation', 'help', 'support', 'blog', 'pricing', 'legal',
  'privacy', 'terms', 'security', 'about', 'contact', 'careers',
  'app', 'dashboard', 'home', 'welcome', 'new', 'settings', 'billing',
] as const;

/**
 * Words that are confusing or hostile as a tenant identifier regardless of routing —
 * impersonation risks and reserved-looking names.
 */
const UNIVERSALLY_RESERVED = [
  'null', 'undefined', 'true', 'false', 'nan', 'void',
  'root', 'superuser', 'sysadmin', 'administrator', 'moderator',
  'official', 'staff', 'team-woidmod', 'woidmod', 'support-team',
  'test', 'testing', 'example', 'demo', 'sample', 'placeholder',
] as const;

export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  ...TOP_LEVEL_ROUTES,
  ...UNIVERSALLY_RESERVED,
]);

export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  ...ORG_LEVEL_ROUTES,
  ...UNIVERSALLY_RESERVED,
]);

export type SlugKind = 'organization' | 'workspace';

function reservedSetFor(kind: SlugKind): ReadonlySet<string> {
  return kind === 'organization' ? RESERVED_ORG_SLUGS : RESERVED_WORKSPACE_SLUGS;
}

export function isReservedSlug(kind: SlugKind, slug: string): boolean {
  return reservedSetFor(kind).has(slug.toLowerCase());
}

/**
 * Human-facing rejection message. Says *why* the slug is unavailable rather than a
 * bare "invalid" — "settings" looks perfectly valid to the person typing it.
 */
export function reservedSlugMessage(kind: SlugKind, slug: string): string {
  return (
    `"${slug}" is a reserved ${kind} identifier — it would collide with a platform ` +
    `URL. Choose a different one.`
  );
}

/**
 * Makes an auto-generated slug safe.
 *
 * Used where WE derive a slug from a name (signup provisioning, workspace creation
 * without an explicit slug). Suffixes rather than rejecting, because auto-generation
 * has no user to show an error to — a company genuinely called "Settings" must still
 * be able to sign up.
 */
export function deconflictSlug(kind: SlugKind, slug: string): string {
  if (!isReservedSlug(kind, slug)) return slug;
  const suffix = kind === 'organization' ? '-org' : '-ws';
  // Respect the 48-char schema limit.
  return `${slug.slice(0, 48 - suffix.length)}${suffix}`;
}
