-- Migration: fabric_vault_phase_10a_2
-- Target: optimalos
-- Created: 2026-05-03T21:51:50.340Z
--
-- OptimalVault — Phase 10a-2 schema.
--
-- Tables:
--   vault_entries     — age-encrypted credential blobs (multi-recipient)
--   vault_recipients  — registered age public keys (browser/device/recovery)
--   vault_access_log  — audit trail (one row per successful entry GET)
--
-- Source-of-truth: ~/.optimalos/transfers/fabric-design/02-vault-design.md §4
-- All statements idempotent (IF NOT EXISTS / DO $$ ... END $$ blocks) so re-runs
-- are safe per ~/CLAUDE.md "SQL / Database Rules".
--
-- Single-tenant per Decision-ledger #3 (post-Wave-1 amendment): no user_id
-- column in v1 — authMiddleware (passphrase or X-Cron-Key) gates the routes.
-- TODO(phase-14): RLS when self-host lands.

-- ── vault_entries ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vault_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label            text NOT NULL,
  kind             text NOT NULL,                       -- 'api_key' | 'oauth_refresh' | 'ssh_key' | 'env_blob'
  ciphertext       bytea NOT NULL,                      -- age-encryption.org/v1 binary blob
  recipients_hash  text NOT NULL,                       -- sha256 of sorted recipient pubkeys; dirty-flag for re-wrap
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_entries_kind
  ON vault_entries(kind);

CREATE INDEX IF NOT EXISTS idx_vault_entries_recipients_hash
  ON vault_entries(recipients_hash);

-- ── vault_recipients ───────────────────────────────────────────────
--
-- Per Decision-ledger amendment #12 (trusted-device pattern): a single user
-- may register multiple browser-fingerprint pubkeys without conflict —
-- pubkey UNIQUE is the only identity constraint, intentional.

CREATE TABLE IF NOT EXISTS vault_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('browser', 'device', 'recovery')),
  pubkey      text NOT NULL UNIQUE,                     -- age1... bech32 string
  label       text,                                     -- 'pop-os', 'iPhone Safari', 'paper-recovery-2026-05-03'
  device_id   uuid,                                     -- nullable; FK to devices(id) added in Phase 10b
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz                               -- soft-revoke; non-null hides from active set
);

-- Hot path: list all currently-active recipients of a given kind.
CREATE INDEX IF NOT EXISTS idx_vault_recipients_kind_active
  ON vault_recipients(kind)
  WHERE revoked_at IS NULL;

-- ── vault_access_log ───────────────────────────────────────────────
--
-- One row per successful GET /api/vault/entries/:id. recipient_id is nullable
-- for v1 (server-side log lacks visibility into which recipient identity the
-- caller will use to decrypt — that's a device-daemon concern in 10a-4).

CREATE TABLE IF NOT EXISTS vault_access_log (
  id            bigserial PRIMARY KEY,
  entry_id      uuid REFERENCES vault_entries(id) ON DELETE CASCADE,
  recipient_id  uuid REFERENCES vault_recipients(id) ON DELETE SET NULL,
  session_id    uuid,
  decrypted_at  timestamptz NOT NULL DEFAULT now(),
  ip            inet,
  user_agent    text
);

CREATE INDEX IF NOT EXISTS idx_vault_access_log_entry
  ON vault_access_log(entry_id, decrypted_at DESC);

-- ── updated_at trigger ─────────────────────────────────────────────
--
-- Routes also bump updated_at explicitly on PUT, but a trigger guarantees
-- consistency when rows are touched directly (psql, dashboard, future
-- bulk-rewrap helpers).

CREATE OR REPLACE FUNCTION vault_entries_set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'vault_entries_updated_at'
  ) THEN
    CREATE TRIGGER vault_entries_updated_at
      BEFORE UPDATE ON vault_entries
      FOR EACH ROW EXECUTE FUNCTION vault_entries_set_updated_at();
  END IF;
END $$;
