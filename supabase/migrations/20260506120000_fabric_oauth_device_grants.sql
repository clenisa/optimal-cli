-- Migration: fabric_oauth_device_grants
-- Target: optimalos
-- Created: 2026-05-06T12:00:00Z
--
-- Phase 13a-1 — RFC 8628 OAuth 2.0 Device Authorization Grant.
--
-- Strictly additive complement to the existing token-paste pairing flow
-- (`pairing_tokens` from 20260503221013_fabric_devices_phase_10b_3.sql).
-- The token-paste path stays available; this table backs the new
-- `/api/auth/devices/oauth/{code,token,approve,deny,lookup}` endpoints.
--
-- The plaintext device_code + user_code are NEVER stored — only their SHA-256
-- hex hashes. The hashes are unique so a code looked up via
-- `tokenHash(plaintext)` resolves to at most one row.
--
-- Lifecycle:
--   pending  → /code mints the row (no operator action yet)
--   approved → /approve marks it (authenticated browser session required)
--   consumed → /token consumes an approved row, atomically inserting the
--              device + recipient on the same UPDATE-RETURNING.
--   denied   → /deny marks it (operator rejected on /oauth/device).
--   expired  → set lazily by /token when expires_at < now() AND status='pending'.
--
-- Source-of-truth:
--   ~/.openclaw/workspace/optimalOS/docs/superpowers/plans/2026-05-03-fabric-implementation.md
--     (Phase 13a-1)
--   RFC 8628 §3.2 (device authorization response shape) and §3.5 (token
--     endpoint polling responses: authorization_pending, slow_down,
--     access_denied, expired_token).
--
-- All statements idempotent (`CREATE TABLE IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`, RLS via DROP-then-CREATE) per
-- ~/CLAUDE.md "SQL / Database Rules".

-- ── oauth_device_grants ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oauth_device_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash  text NOT NULL UNIQUE,                 -- sha256(device_code) hex
  user_code_hash    text NOT NULL UNIQUE,                 -- sha256(user_code)   hex
  client_label      text,                                 -- self-claimed by device at /code
  capabilities      text[] NOT NULL DEFAULT '{}',         -- self-claimed
  device_pubkey     text,                                 -- bound at /token call (TOFU)
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','denied','consumed','expired')),
  approved_by       text,                                 -- browser pubkey or legacy:<prefix>
  approved_at       timestamptz,
  last_polled_at    timestamptz,                          -- enforces RFC 8628 slow_down
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_device_grants_expires_idx
  ON oauth_device_grants(expires_at);

CREATE INDEX IF NOT EXISTS oauth_device_grants_status_idx
  ON oauth_device_grants(status)
  WHERE status IN ('pending','approved');

-- ── RLS — match the T2 RLS pattern (deny-by-default, service_role passthrough) ──

ALTER TABLE oauth_device_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_device_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON oauth_device_grants;
CREATE POLICY "service_role_all" ON oauth_device_grants
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- anon + authenticated: NO POLICY = deny by default. Same posture as
-- vault_entries / pairing_tokens / devices in 20260505212121_fabric_vault_t2_rls.sql.
