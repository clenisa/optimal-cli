-- Add source column to dim_program_id to distinguish NetSuite operational
-- programs from FP&A budgeting entries
ALTER TABLE dim_program_id
ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'netsuite';

COMMENT ON COLUMN dim_program_id.source IS
  'Origin: netsuite = confirmed operational, fpa = FP&A/budgeting entry, manual = user-added';
