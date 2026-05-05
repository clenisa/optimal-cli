-- Migration: add_vault_rewrap_batch_rpc
-- Target: optimalos
-- Created: 2026-05-05T05:34:29.064Z
--
-- Atomic batch re-wrap RPC for vault entries (P1-#8).
-- Replaces the multi-row UPDATE loop in SupabaseVaultStorage.rewrap with
-- a single transactional plpgsql function. Caller passes a JSON array of
-- { id, ciphertext_b64, recipients_hash } — the function UPDATEs all rows
-- in one statement. Either every row updates or none do.
--
-- Threat addressed: §3-R from
-- ~/.optimalos/transfers/fabric-design/06-vault-auth-threat-rerun.md —
-- best-effort rollback today leaves vault half-rewrapped on mid-batch
-- failure. This RPC moves rewrap into a single Postgres transaction so the
-- whole batch either commits or aborts atomically.

CREATE OR REPLACE FUNCTION vault_rewrap_batch(p_items jsonb)
RETURNS TABLE (id uuid, updated boolean) AS $$
BEGIN
  -- Validate input shape early.
  IF jsonb_typeof(p_items) IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array';
  END IF;

  -- Single statement: explode the JSON array into a CTE and UPDATE FROM it.
  -- Postgres wraps the entire function body in a transaction by default;
  -- any RAISE aborts and rolls back all UPDATEs within this call.
  RETURN QUERY
  WITH inputs AS (
    SELECT
      (e->>'id')::uuid AS id,
      decode(e->>'ciphertext_b64', 'base64') AS ciphertext,
      e->>'recipients_hash' AS recipients_hash
    FROM jsonb_array_elements(p_items) AS e
  ),
  updated_rows AS (
    UPDATE vault_entries v
    SET
      ciphertext = i.ciphertext,
      recipients_hash = i.recipients_hash,
      updated_at = now()
    FROM inputs i
    WHERE v.id = i.id
    RETURNING v.id
  )
  SELECT i.id, (u.id IS NOT NULL) AS updated
  FROM inputs i
  LEFT JOIN updated_rows u ON u.id = i.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Service role only (matches vault_entries access pattern).
REVOKE ALL ON FUNCTION vault_rewrap_batch(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault_rewrap_batch(jsonb) TO service_role;
