-- Migration: fabric_devices_phase_10b_3
-- Target: optimalos
-- Created: 2026-05-03T22:10:13.027Z
--
-- Fabric Phase 10b-3 — devices table + tighten vault_recipients.device_id FK.
--
-- Source-of-truth: ~/.openclaw/workspace/optimalOS/docs/superpowers/plans/2026-05-03-fabric-implementation.md
-- (Phase 10b-3 deliverable §4) and ~/.optimalos/transfers/fabric-design/02-vault-design.md.
--
-- The 10a-2 migration declared `vault_recipients.device_id uuid` without an FK
-- because the `devices` table didn't exist yet. This phase introduces it and
-- back-fills the FK constraint via an idempotent DO-block.
--
-- All statements are idempotent (`IF NOT EXISTS`, guarded ALTER) per
-- ~/CLAUDE.md "SQL / Database Rules".

-- ── devices ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text NOT NULL,
  pubkey          text NOT NULL UNIQUE,           -- age bech32; mirrors vault_recipients.pubkey
  capabilities    text[] NOT NULL DEFAULT '{}',
  hostname        text,
  tailscale_ip    inet,
  paired_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  status          text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'unpaired'))
);

CREATE INDEX IF NOT EXISTS devices_pubkey_idx ON devices(pubkey);

CREATE INDEX IF NOT EXISTS devices_status_active_idx
  ON devices(status)
  WHERE status <> 'offline';

-- ── vault_recipients.device_id FK ──────────────────────────────────
--
-- 10a-2 left device_id un-FK'd. Add the constraint now, idempotently.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'vault_recipients_device_id_fkey'
  ) THEN
    ALTER TABLE vault_recipients
      ADD CONSTRAINT vault_recipients_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── pairing_tokens (server-side hash store) ────────────────────────
--
-- The pairing JWT itself is stateless (signed). We additionally persist a
-- hash of every issued pairing token so we can enforce single-use semantics
-- across cloud restarts. Phase 10b-3 plan §3 calls this out as orthogonal to
-- the JWT exp check.

CREATE TABLE IF NOT EXISTS pairing_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE,           -- sha256(jwt) hex
  issued_by       text,                           -- browser pubkey that minted it
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  device_id       uuid REFERENCES devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pairing_tokens_active_idx
  ON pairing_tokens(token_hash)
  WHERE used_at IS NULL;
