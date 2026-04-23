-- Migration: loom_step_runs_ack
-- Target: optimalos
-- Created: 2026-04-23T21:14:26.982Z
--
-- Adds ack_at column to loom_step_runs so the UI can acknowledge
-- persistent-red step failures and stop surfacing them as active alerts.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'loom_step_runs' AND column_name = 'ack_at'
  ) THEN
    ALTER TABLE loom_step_runs ADD COLUMN ack_at timestamptz NULL;
  END IF;
END $$;
