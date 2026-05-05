-- Migration: add_vault_install_table
-- Target: optimalos
-- Created: 2026-05-05T05:34:02.513Z
--
-- Phase 10a-7 P1-#7 — per-install Argon2id salt for the OptimalVault KDF.
--
-- Threat (06-vault-auth-threat-rerun.md §3-I): the v1 KDF used the literal
-- string "default-salt" everywhere. A pre-computed Argon2id rainbow table
-- against common passphrases for that fixed salt would work against every
-- Fabric install. Per-install random salt makes each install a unique
-- pre-image target, restoring the per-tenant entropy floor.
--
-- Single-row table guarded by `CHECK (id = 1)` — there is exactly one
-- install salt per Fabric instance. RLS enabled with no policies; only the
-- service-role connection (which bypasses RLS) can read or write.
--
-- All statements idempotent per ~/CLAUDE.md "SQL / Database Rules".

CREATE TABLE IF NOT EXISTS vault_install (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  salt_b64    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Tighten access — vault_install is service-role-only. Enabling RLS without
-- declaring any policies means PostgREST anon/authenticated calls return 0
-- rows and refuse writes. The Bun server uses the service-role key and
-- bypasses RLS, which is what mints + reads the salt.
ALTER TABLE vault_install ENABLE ROW LEVEL SECURITY;
