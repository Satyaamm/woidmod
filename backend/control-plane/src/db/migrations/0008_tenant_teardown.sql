-- ===========================================================================
-- 0008 — Make deleting an organization actually delete its data.
--
-- Twelve org-scoped tables cascade from `organizations`; eight did not carry a
-- foreign key on `org_id` at all. Deleting an org therefore left rows behind with
-- nothing pointing at them and nothing to ever collect them — observed in practice:
-- a deleted tenant's `tenant_keys` row (its envelope-encryption key) and its
-- `provider_credentials` (encrypted BYOK secrets) both survived the tenant.
--
-- That is a data-retention problem, not a tidiness one: the customer is gone, the
-- contract is over, and their key material is still in the database.
--
-- TWO TABLES ARE DELIBERATELY EXCLUDED — `audit_log` and `dispatch_audit`. Both are
-- append-only records of decisions, and an audit trail that disappears when the
-- subject of the audit is deleted is not an audit trail. They are retained on
-- purpose and erased by the retention job, which redacts the personal fields and
-- keeps the decision. Adding a cascade here would let an org deletion quietly erase
-- the evidence of how that org behaved.
-- ===========================================================================

-- Orphans predating this migration would block the constraints below. Removing them
-- is the whole point of the change, so it happens here rather than being left for an
-- operator to discover as a failed migration.
DELETE FROM tenant_keys          t WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = t.org_id);
DELETE FROM provider_credentials p WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p.org_id);
DELETE FROM custom_roles         r WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = r.org_id);
DELETE FROM call_traces          c WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id);
DELETE FROM call_records         c WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id);
DELETE FROM sessions             s WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = s.org_id);

DO $$
DECLARE
  t text;
  -- Ordered so a child is constrained before its parent is read by the next entry.
  cascading text[] := ARRAY[
    'tenant_keys',
    'provider_credentials',
    'custom_roles',
    'call_traces',
    'call_records',
    -- A session is anchored to one org; when that org is gone the session cannot be
    -- resolved to anything, so keeping it only leaves a dangling credential.
    'sessions'
  ];
BEGIN
  FOREACH t IN ARRAY cascading LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_org_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE',
      t, t || '_org_fk'
    );
  END LOOP;
END $$;
