-- Loom Phase 2: Supabase workflow schema
-- Idempotent — safe to re-run on existing databases.

-- Extend openclaw_instances with capability columns
ALTER TABLE openclaw_instances
  ADD COLUMN IF NOT EXISTS capabilities text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tailscale_hostname text,
  ADD COLUMN IF NOT EXISTS cpu_cores int,
  ADD COLUMN IF NOT EXISTS mem_gb int,
  ADD COLUMN IF NOT EXISTS disk_gb int,
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'worker',
  ADD COLUMN IF NOT EXISTS hub_lease_until timestamptz;

-- Workflow definitions
CREATE TABLE IF NOT EXISTS loom_workflows (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  description   text,
  module_path   text NOT NULL,
  schedule      text,
  trigger_type  text NOT NULL DEFAULT 'cron',
  requires_caps text[] DEFAULT '{}',
  default_host  text,
  enabled       boolean NOT NULL DEFAULT true,
  owner_email   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Workflow steps
CREATE TABLE IF NOT EXISTS loom_workflow_steps (
  workflow_id   text NOT NULL REFERENCES loom_workflows(id) ON DELETE CASCADE,
  step_id       text NOT NULL,
  label         text NOT NULL,
  seq           int NOT NULL,
  depends_on    text[] DEFAULT '{}',
  host_hint     text,
  timeout_ms    int NOT NULL DEFAULT 300000,
  retries       int NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, step_id)
);

-- Runs (parent)
CREATE TABLE IF NOT EXISTS loom_runs (
  run_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   text NOT NULL REFERENCES loom_workflows(id) ON DELETE CASCADE,
  trigger       text NOT NULL,
  trigger_by    text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL,
  host          text,
  summary       jsonb
);
CREATE INDEX IF NOT EXISTS idx_loom_runs_workflow ON loom_runs(workflow_id, started_at DESC);

-- Step runs (child)
CREATE TABLE IF NOT EXISTS loom_step_runs (
  run_id        uuid NOT NULL REFERENCES loom_runs(run_id) ON DELETE CASCADE,
  step_id       text NOT NULL,
  host          text NOT NULL,
  status        text NOT NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  exit_code     int,
  output_tail   text,
  error         text,
  result_json   jsonb,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_loom_step_runs_status ON loom_step_runs(status);

-- Cross-node job queue (Phase 9 prerequisite)
CREATE TABLE IF NOT EXISTS loom_job_queue (
  job_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES loom_runs(run_id) ON DELETE CASCADE,
  workflow_id   text NOT NULL,
  step_id       text NOT NULL,
  target_host   text NOT NULL,
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  claimed_by    text,
  claimed_at    timestamptz,
  payload       jsonb
);
CREATE INDEX IF NOT EXISTS idx_loom_job_queue_pending
  ON loom_job_queue(target_host, enqueued_at)
  WHERE claimed_by IS NULL;
