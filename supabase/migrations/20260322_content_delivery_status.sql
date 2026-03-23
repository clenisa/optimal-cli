-- Delivery Status Reconciliation Table
-- Mirrors actual platform delivery status and compares against Strapi

CREATE TABLE IF NOT EXISTS content_delivery_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL,
  strapi_document_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_post_id TEXT,
  platform_status TEXT NOT NULL DEFAULT 'unknown',
  strapi_status TEXT,
  status_match BOOLEAN GENERATED ALWAYS AS (platform_status = strapi_status) STORED,
  last_checked_at TIMESTAMPTZ DEFAULT now(),
  platform_metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(strapi_document_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_delivery_status_mismatch
  ON content_delivery_status (status_match) WHERE status_match = false;
CREATE INDEX IF NOT EXISTS idx_delivery_status_brand
  ON content_delivery_status (brand);
CREATE INDEX IF NOT EXISTS idx_delivery_status_type
  ON content_delivery_status (content_type);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_delivery_status_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_delivery_status_updated ON content_delivery_status;
CREATE TRIGGER trg_delivery_status_updated
  BEFORE UPDATE ON content_delivery_status
  FOR EACH ROW EXECUTE FUNCTION update_delivery_status_updated_at();
