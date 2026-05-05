-- Migration: fabric_vault_t2_rls
-- Target: optimalos
-- Created: 2026-05-05T21:21:21Z
--
-- Phase 14 / P1 — Closes T2 ("Supabase row exfiltration") from the OptimalVault
-- threat-model re-walk. The v1 schema migration `20260503215150_fabric_vault_phase_10a_2.sql`
-- (line 18) carried the `TODO(phase-14): RLS when self-host lands.` placeholder
-- because the OptimalOS server connects with the Supabase service_role key
-- which bypasses RLS. This migration adds RLS as defense-in-depth so that:
--
--   1. If a non-service-role connection is ever opened against this instance
--      (anon, authenticated, a future per-user JWT in Phase 14 multi-tenant,
--      or a stray dashboard/psql session using a non-service role), the vault
--      tables refuse all reads and writes by default.
--   2. Even table owners go through the policy check (`FORCE ROW LEVEL SECURITY`),
--      relevant when bare-password Postgres roles are used.
--
-- Threat reference:
--   ~/.optimalos/transfers/fabric-design/06-vault-auth-threat-rerun.md
--     §2 T2 — single-tenant; remediation P1 (Phase 14)
--     §4 P1 list item #15 — "RLS multi-tenant" (re-graded P1 here as DiD)
--
-- Original schema reference:
--   supabase/migrations/20260503215150_fabric_vault_phase_10a_2.sql  (vault_entries, vault_recipients, vault_access_log)
--   supabase/migrations/20260503221013_fabric_devices_phase_10b_3.sql (devices, pairing_tokens)
--   supabase/migrations/20260505053402_add_vault_install_table.sql    (vault_install — already had ENABLE RLS, no policy / no FORCE)
--
-- Posture after this migration:
--
--   role             | vault_entries | vault_recipients | vault_access_log | devices | pairing_tokens | vault_install
--   -----------------+---------------+------------------+------------------+---------+----------------+---------------
--   service_role     | ALL (allow)   | ALL (allow)      | ALL (allow)      | ALL     | ALL            | ALL
--   anon             | denied        | denied           | denied           | denied  | denied         | denied
--   authenticated    | denied        | denied           | denied           | denied  | denied         | denied
--   table-owner role | gated by RLS  | gated by RLS     | gated by RLS     | gated   | gated          | gated
--
-- Anon and authenticated are deny-by-default: with RLS enabled and no policy
-- declared FOR them, every row is invisible and every write is rejected. This
-- is the standard Supabase "no-policy = deny" pattern; explicitly documented
-- below at each table for future readers.
--
-- All statements idempotent (`DROP POLICY IF EXISTS ... ; CREATE POLICY ...`,
-- `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` is naturally idempotent)
-- per ~/CLAUDE.md "SQL / Database Rules".

-- ── vault_entries ──────────────────────────────────────────────────

ALTER TABLE vault_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_entries FORCE ROW LEVEL SECURITY;

-- service_role: full passthrough — preserves OptimalOS server (Bun + service-role key) operation.
DROP POLICY IF EXISTS "service_role_all" ON vault_entries;
CREATE POLICY "service_role_all" ON vault_entries
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default. Intentional — vault data
-- must never be reachable by a PostgREST anon/authenticated client.

-- ── vault_recipients ───────────────────────────────────────────────

ALTER TABLE vault_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_recipients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON vault_recipients;
CREATE POLICY "service_role_all" ON vault_recipients
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default.

-- ── vault_access_log ───────────────────────────────────────────────

ALTER TABLE vault_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_access_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON vault_access_log;
CREATE POLICY "service_role_all" ON vault_access_log
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default.

-- ── devices ────────────────────────────────────────────────────────

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON devices;
CREATE POLICY "service_role_all" ON devices
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default.

-- ── pairing_tokens ─────────────────────────────────────────────────

ALTER TABLE pairing_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON pairing_tokens;
CREATE POLICY "service_role_all" ON pairing_tokens
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default.

-- ── vault_install ──────────────────────────────────────────────────
--
-- Already had `ENABLE ROW LEVEL SECURITY` from migration
-- 20260505053402_add_vault_install_table.sql but lacked an explicit
-- service_role allow-policy + FORCE. Bringing it in line with the rest of
-- the vault surface for posture consistency.

ALTER TABLE vault_install ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_install FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON vault_install;
CREATE POLICY "service_role_all" ON vault_install
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default.
